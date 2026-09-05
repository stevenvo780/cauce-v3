export function publicGitOrigin(origin: string): string;
export function publicOriginEnvironment(repositoryRoot: string): {
  environment: Record<string, string>;
  cleanup: () => void;
};
