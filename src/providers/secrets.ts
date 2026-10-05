// The server's secret resolver: a credential_ref (secretref:ws/<workspace>/<name>) names an
// environment variable of the server process, SCOPELY_SECRET_WS<workspace>_<NAME>. The secret is
// read at call time, handed to one callback and never returned, logged or written anywhere.
// A real secret store replaces this class behind the same SecretResolver interface (B18 is where
// files go; secrets are the same question for a hosted deployment).
import type { SecretResolver } from '../build/agents.js';
import { ProviderError } from './gateway.js';

export function secretEnvName(credentialRef: string): string {
  const m = /^secretref:ws\/(\d+)\/([a-z0-9][a-z0-9_-]{0,62})$/.exec(credentialRef);
  if (!m) throw new Error('not a workspace secret reference');
  return `SCOPELY_SECRET_WS${m[1]}_${m[2]!.toUpperCase().replace(/-/g, '_')}`;
}

export class EnvSecretResolver implements SecretResolver {
  constructor(private readonly env: Record<string, string | undefined> = process.env) {}
  async withSecret<T>(credentialRef: string, use: (secret: string) => Promise<T>): Promise<T> {
    const secret = this.env[secretEnvName(credentialRef)];
    if (!secret) throw new ProviderError('auth', 'the credential for this connection is not configured on the server');
    return use(secret);
  }
}
