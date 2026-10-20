import Docker from 'dockerode';
import process from 'node:process';

let dockerInstance: Docker | null = null;
let cachedRuntime: string | undefined = undefined;

export function getDockerClient(): Docker {
  if (!dockerInstance) {
    if (process.platform === 'win32') {
      dockerInstance = new Docker({
        socketPath: '//./pipe/dockerDesktopLinuxEngine',
      });
    } else {
      dockerInstance = new Docker();
    }
  }
  return dockerInstance;
}

export async function resolveSandboxRuntime(docker: Docker): Promise<string | undefined> {
  if (cachedRuntime !== undefined) {
    return cachedRuntime || undefined;
  }

  const requestedRuntime = process.env.SANDBOX_RUNTIME || 'runsc';

  try {
    const info = await docker.info();
    const availableRuntimes = Object.keys(info.Runtimes || {});

    if (availableRuntimes.includes(requestedRuntime)) {
      console.log(`[SANDBOX] Active execution runtime: ${requestedRuntime}`);
      cachedRuntime = requestedRuntime;
      return requestedRuntime;
    }

    console.warn(
      `[SANDBOX_WARN] Requested runtime '${requestedRuntime}' is not configured in Docker daemon (available: [${availableRuntimes.join(', ')}]). ` +
      `Falling back to hardened 'runc' for development. Untrusted production execution requires '${requestedRuntime}'.`
    );
    cachedRuntime = '';
    return undefined;
  } catch (err) {
    console.warn(`[SANDBOX_WARN] Failed to query Docker runtimes, falling back to default:`, err);
    cachedRuntime = '';
    return undefined;
  }
}
