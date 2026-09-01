import type { Delivery } from "../types.js";
import { clone } from "./atomic-state.js";
import { DurableStoreBase } from "./base.js";
import type {
  DelegationBranchIdentity,
  DelegationBranchProgress,
  InboxRecord,
  ProcessedFaninReply,
} from "./contracts.js";
import { objectRecord, visibleText } from "./delivery-helpers.js";

export class DurableStoreFanin extends DurableStoreBase {
  getDelivery(deliveryId: string): InboxRecord | undefined {
    const record = this.inbox.deliveries[deliveryId] ?? this.terminalHistory.get(deliveryId);
    return record === undefined ? undefined : clone(record);
  }

  protected faninRoot(delivery: Delivery): InboxRecord | undefined {
    if (delivery.body.type !== "agent.fanin") return undefined;
    const correlation = objectRecord(delivery.body.correlation);
    const rootMessageId = typeof correlation?.root_message_id === "string"
      ? correlation.root_message_id
      : undefined;
    const rootDeliveryId = typeof correlation?.root_delivery_id === "string"
      ? correlation.root_delivery_id
      : undefined;
    if (rootMessageId === undefined || rootDeliveryId === undefined) return undefined;
    const root = this.inbox.deliveries[rootDeliveryId];
    if (
      root?.state !== "done"
      || root.request === undefined
      || root.output === undefined
      || root.request.message_id !== rootMessageId
      || root.request.trace_id !== delivery.trace_id
      || root.request.recipient_alias !== delivery.recipient_alias
      || root.output.messages.length === 0
    ) {
      return undefined;
    }
    return root;
  }

  protected continuationBelongsToRoot(delivery: Delivery, rootDeliveryId: string): boolean {
    const seen = new Set<string>();
    let response: Delivery | undefined = delivery;
    for (let depth = 0; response !== undefined && depth < 16; depth += 1) {
      const source = this.continuationSource(response);
      if (source === undefined || seen.has(source.delivery_id)) return false;
      if (source.delivery_id === rootDeliveryId) return true;
      seen.add(source.delivery_id);
      response = source.request?.body.type === "agent.response" ? source.request : undefined;
    }
    return false;
  }

  /**
   * Resolves an authenticated agent.response back to the exact local delivery
   * that created its delegated branch. The local terminal output is part of
   * the proof: a wire correlation alone can never recover retained context.
   */
  continuationSource(delivery: Delivery): InboxRecord | undefined {
    if (delivery.body.type !== "agent.response") return undefined;
    const correlation = objectRecord(delivery.body.correlation);
    const sourceDeliveryId = typeof correlation?.response_to_delivery_id === "string"
      ? correlation.response_to_delivery_id
      : undefined;
    const childDeliveryId = typeof correlation?.child_delivery_id === "string"
      ? correlation.child_delivery_id
      : undefined;
    if (sourceDeliveryId === undefined) return undefined;
    const source = this.inbox.deliveries[sourceDeliveryId];
    const exactBranch = source?.delegation_materializations;
    const correlatedBranch = exactBranch === undefined
      ? source?.output?.messages.some((message) => message.to === delivery.actor_alias)
      : childDeliveryId !== undefined && exactBranch.some((branch) => (
          branch.child_delivery_id === childDeliveryId
          && branch.target_alias === delivery.actor_alias
        ));
    if (
      source?.state !== "done"
      || source.request === undefined
      || source.output === undefined
      || source.request.trace_id !== delivery.trace_id
      || source.request.recipient_alias !== delivery.recipient_alias
      || !correlatedBranch
    ) {
      return undefined;
    }
    return clone(source);
  }

  /**
   * Estado de las ramas hermanas del abanico que esta `agent.response` viene a cerrar.
   *
   * Consolida el estado desde el inbox durable local:
   *  - `branches`: entregas materializadas por el store (por output_index y child_delivery_id);
   *  - `rejected`: salidas rechazadas por el store;
   *  - `returned`: respuestas generadas al cerrar ramas hermanas;
   *  - `pending`: ramas pendientes restantes.
   *
   * Devuelve `undefined` para abanicos de una sola rama.
   */
  branchProgressForResponse(delivery: Delivery): DelegationBranchProgress | undefined {
    const source = this.continuationSource(delivery);
    if (source?.request === undefined || source.output === undefined) return undefined;
    const rejected = (source.delegation_rejections ?? []).map((rejection) => ({
      output_index: rejection.output_index,
      ...(rejection.target === undefined ? {} : { target: rejection.target }),
      code: rejection.code,
    }));
    const rejectedIndexes = new Set(rejected.map((rejection) => rejection.output_index));
    const branches: DelegationBranchIdentity[] = source.delegation_materializations === undefined
      ? source.output.messages.flatMap((message, outputIndex) => (
          rejectedIndexes.has(outputIndex)
            ? []
            : [{ outputIndex, alias: message.to }]
        ))
      : [...source.delegation_materializations]
          .sort((left, right) => left.output_index - right.output_index)
          .map((branch) => ({
            outputIndex: branch.output_index,
            targetTenant: branch.target_tenant,
            alias: branch.target_alias,
            childDeliveryId: branch.child_delivery_id,
          }));
    if (Math.max(source.output.messages.length, branches.length + rejected.length) < 2) return undefined;

    const returned = Object.values(this.inbox.deliveries)
      .filter((record) => {
        if (record.delivery_id === delivery.delivery_id) return false;
        const request = record.request;
        const correlation = objectRecord(request?.body.correlation);
        return record.state === "done"
          && request?.body.type === "agent.response"
          && request.trace_id === delivery.trace_id
          && request.recipient_alias === delivery.recipient_alias
          && correlation?.response_to_delivery_id === source.delivery_id
          && this.continuationSource(request)?.delivery_id === source.delivery_id
          && visibleText(record.output?.reply);
      })
      .sort((left, right) =>
        right.updated_at.localeCompare(left.updated_at)
        || right.delivery_id.localeCompare(left.delivery_id))
      .map((record): ProcessedFaninReply => {
        const request = record.request;
        const output = record.output;
        if (request === undefined || output === undefined || !visibleText(output.reply)) {
          throw new Error("Durable fan-in reply has no validated request or output");
        }
        const correlation = objectRecord(request.body.correlation);
        const childDeliveryId = typeof correlation?.child_delivery_id === "string"
          ? correlation.child_delivery_id
          : undefined;
        const exact = childDeliveryId === undefined
          ? undefined
          : branches.find((branch) => branch.childDeliveryId === childDeliveryId);
        return {
          tenantId: request.tenant_id,
          alias: request.actor_alias,
          reply: output.reply.trim(),
          updatedAt: record.updated_at,
          sourceDeliveryId: source.delivery_id,
          ...(childDeliveryId === undefined ? {} : { childDeliveryId }),
          ...(exact === undefined ? {} : {
            outputIndex: exact.outputIndex,
            ...(exact.targetTenant === undefined ? {} : { targetTenant: exact.targetTenant }),
          }),
        };
      });

    const currentCorrelation = objectRecord(delivery.body.correlation);
    const currentChildDeliveryId = typeof currentCorrelation?.child_delivery_id === "string"
      ? currentCorrelation.child_delivery_id
      : undefined;
    const closures = [
      { alias: delivery.actor_alias, childDeliveryId: currentChildDeliveryId },
      ...returned.map((entry) => ({ alias: entry.alias, childDeliveryId: entry.childDeliveryId })),
    ];
    const closedIndexes = new Set<number>();
    const seenChildDeliveries = new Set<string>();
    for (const closure of closures) {
      if (closure.childDeliveryId !== undefined) {
        if (seenChildDeliveries.has(closure.childDeliveryId)) continue;
        seenChildDeliveries.add(closure.childDeliveryId);
        const exact = branches.find((branch) => (
          branch.childDeliveryId === closure.childDeliveryId
          && branch.alias === closure.alias
        ));
        if (exact !== undefined) {
          closedIndexes.add(exact.outputIndex);
          continue;
        }
      }
      // Legacy receipts have no child ids. Consume one unmatched occurrence, never the alias set.
      const legacy = branches.find((branch) => (
        !closedIndexes.has(branch.outputIndex)
        && branch.childDeliveryId === undefined
        && branch.alias === closure.alias
      ));
      if (legacy !== undefined) closedIndexes.add(legacy.outputIndex);
    }
    const pendingBranches = branches.filter((branch) => !closedIndexes.has(branch.outputIndex));
    return {
      delegated: branches.map((branch) => branch.alias),
      branches,
      rejected,
      returned,
      pending: pendingBranches.map((branch) => branch.alias),
      pendingBranches,
    };
  }

  /**
   * Returns every terminal visible reply produced locally while processing
   * correlated child responses for this fan-in root. Branch text from the wire
   * is deliberately not consulted here.
   */
  processedRepliesForFanin(delivery: Delivery): readonly ProcessedFaninReply[] {
    const root = this.faninRoot(delivery);
    if (root?.request === undefined) return [];
    const correlation = objectRecord(delivery.body.correlation);
    const rootMessageId = correlation?.root_message_id;
    const rootDeliveryId = root.delivery_id;

    return Object.values(this.inbox.deliveries)
      .filter((record) => {
        const request = record.request;
        const responseCorrelation = objectRecord(request?.body.correlation);
        return record.state === "done"
          && request?.body.type === "agent.response"
          && request.trace_id === delivery.trace_id
          && request.recipient_alias === delivery.recipient_alias
          && responseCorrelation?.root_message_id === rootMessageId
          && responseCorrelation?.root_delivery_id === rootDeliveryId
          && this.continuationBelongsToRoot(request, rootDeliveryId)
          && record.output?.messages.length === 0
          && visibleText(record.output.reply);
      })
      // Newest first: the coordinator's last completed turn is its actual synthesis, and
      // tenant/alias/delivery ordering says nothing about which reply that is.
      .sort((left, right) =>
        right.updated_at.localeCompare(left.updated_at)
        || right.delivery_id.localeCompare(left.delivery_id))
      .map((record): ProcessedFaninReply => {
        const request = record.request;
        const output = record.output;
        if (request === undefined || output === undefined || !visibleText(output.reply)) {
          throw new Error("Durable fan-in reply has no validated request or output");
        }
        const correlation = objectRecord(request.body.correlation);
        const childDeliveryId = correlation?.child_delivery_id;
        const sourceDeliveryId = correlation?.response_to_delivery_id;
        return {
          tenantId: request.tenant_id,
          alias: request.actor_alias,
          reply: output.reply.trim(),
          updatedAt: record.updated_at,
          ...(typeof childDeliveryId === "string" && childDeliveryId.length > 0
            ? { childDeliveryId }
            : {}),
          ...(typeof sourceDeliveryId === "string" && sourceDeliveryId.length > 0
            ? { sourceDeliveryId }
            : {}),
        };
      });
  }

  pendingDeliveries(): readonly InboxRecord[] {
    return Object.values(this.inbox.deliveries)
      .filter((record) => record.state === "accepted" || record.state === "started")
      .map(clone);
  }

}
