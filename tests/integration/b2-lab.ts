import { getContainerRuntimeClient } from 'testcontainers';

export async function requireDockerLab(): Promise<void> {
  if (!process.env.TESTCONTAINERS_HOST_OVERRIDE) {
    throw new Error('B2 requires an explicit Testcontainers host before resolving the runtime');
  }
  const runtime = await getContainerRuntimeClient();
  const info: unknown = await runtime.container.dockerode.info();
  if (typeof info !== 'object' || info === null || !('Name' in info) || info.Name !== 'docker-lab') {
    throw new Error('B2 requires the Docker Lab daemon before creating resources');
  }
}
