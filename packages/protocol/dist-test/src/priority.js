/**
 * Ordering policy for the delivery queue.
 *
 * `messages.priority` is one signed integer and `claimDeliveries` orders by it DESC with
 * `(available_at, created_at)` as the tiebreak. While every producer writes 0 the tiebreak IS the
 * policy, so a person's fresh question is served strictly after every machine message that the
 * fleet already queued — which is what measured 2.700 agent deliveries sitting in front of 310
 * Telegram messages from the owner over seven days.
 *
 * The fix is a reserved band that only a person can enter, plus a ceiling that every automatic
 * producer is held below. The wire schemas keep the full -100..100 range on purpose: an operator
 * may legitimately escalate. The ceiling is applied where the AUTHENTICATED ROLE of the producer is
 * known (the gateway publish surface) and at the three store paths where an ACK turns into a new
 * message, because those copy the parent's priority and would otherwise let a human's number
 * propagate into the machine traffic it spawned.
 *
 *   -100 .. 50   agent band. Everything an agent can cause, self-assigned or inherited.
 *     51 .. 59   deliberately empty. The gap makes `priority >= HUMAN_PRIORITY_FLOOR` an
 *                unambiguous "a person is waiting" test and leaves room to split the band later
 *                without renumbering anything already in flight.
 *     60 .. 100  human band. 70 is where a chat message from an allowlisted person enters;
 *                71..100 stays free for an operator who escalates deliberately from the console.
 *
 * Anti-starvation: the band is granted at the ENTRY POINT ONLY and does not propagate. The work a
 * human request spawns runs at agent priority, so the privileged set is exactly the human message
 * rate (456 of 5.048 messages in the measured week, 9%) and cannot grow with fan-out.
 */
/** Highest priority any agent-caused message may carry, self-assigned or inherited. */
export const AGENT_PRIORITY_CEILING = 50;
/** At or above this, a message is a person waiting. Nothing automatic may reach it. */
export const HUMAN_PRIORITY_FLOOR = 60;
/** Priority of an inbound chat message from an allowlisted human. */
export const HUMAN_CHAT_PRIORITY = 70;
/**
 * Hold an agent-caused priority under the ceiling.
 *
 * Clamps instead of rejecting on purpose: this runs on the publish path of a live fleet and on
 * ACK materialization, where an exception would turn an over-eager `priority` into a failed
 * delivery or an aborted dispatcher tick. The value is defensive against non-integers because it
 * also runs over `messages.priority` read back from PostgreSQL.
 */
export function clampAgentPriority(priority) {
    if (!Number.isFinite(priority))
        return 0;
    return Math.min(Math.trunc(priority), AGENT_PRIORITY_CEILING);
}
/** True when the priority belongs to the reserved human band. */
export function isHumanPriority(priority) {
    return Number.isFinite(priority) && priority >= HUMAN_PRIORITY_FLOOR;
}
//# sourceMappingURL=priority.js.map