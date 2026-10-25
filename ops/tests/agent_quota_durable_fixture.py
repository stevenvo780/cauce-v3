from __future__ import annotations

import json
import sys

from test_fleet_executor_agent_quota import DockerAgentQuotaTest


def main():
    config = json.loads(sys.stdin.readline())
    DockerAgentQuotaTest.setUpClass()
    fixture = DockerAgentQuotaTest()
    initialized = False
    try:
        fixture.setUp()
        initialized = True
        fixture.policy['host_id'] = config['host_id']
        fixture.agent.update(tenant_id=config['tenant_id'], host_id=config['host_id'])
        dynamic_account = config.get('dynamic_account')
        packets = [fixture.configure_canary(dynamic_account=dynamic_account), fixture.configure_canary()]
        packets.append(fixture.configure_canary(harness='openclaw'))
        print(json.dumps({'policy_file': str(fixture.policy_file), 'agents': [packet['agent'] for packet in packets]}), flush=True)
        if sys.stdin.readline().strip() != 'close':
            raise ValueError('fixture cleanup handshake is required')
    finally:
        if initialized:
            fixture.tearDown()
        DockerAgentQuotaTest.tearDownClass()


if __name__ == '__main__':
    main()
