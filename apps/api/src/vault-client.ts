import type { LivenessFrame } from '@rexell/biometrics';
/**
 * Client for the biometric vault.
 *
 * The types below are declared locally rather than imported from the vault
 * package, on purpose. There is no dependency edge from the API to the vault's
 * code — only to its wire contract — so nothing in the application plane can
 * reach a `VaultStore` by importing it, accidentally or otherwise.
 *
 * Note what this interface cannot express: there is no `getTemplate`. The
 * boundary is enforced by the vault having no such route, and mirrored here by
 * there being no such method to call.
 */

export interface LivenessChallenge {
  readonly id: string;
  readonly kind: string;
  readonly nonce: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
}

export interface LivenessProof {
  readonly challengeId: string;
  readonly nonce: string;
  readonly passiveScore: number;
  readonly actionCompleted: boolean;
  /**
   * The sampled capture the vault re-derives the verdict from.
   *
   * The application plane passes it straight through without looking at it.
   * Judging it needs the challenge, and the challenge lives in the vault —
   * which is also the only process that should be handling frames of somebody's
   * face.
   */
  readonly frames?: readonly LivenessFrame[];
}

export interface EnrolResult {
  readonly templateRef: string;
  readonly replaced: boolean;
  readonly dedupe: {
    readonly status: 'clear' | 'review';
    readonly matches: ReadonlyArray<{ identityId: string; score: number }>;
  };
}

export interface MatchResult {
  readonly matched: boolean;
  readonly identityId?: string;
  readonly score: number;
}

export interface DeletionReceipt {
  readonly receiptId: string;
  readonly identityId: string;
  readonly deletedCount: number;
  readonly reason: string;
  readonly deletedAt: number;
  readonly digest: string;
}

export class VaultUnavailable extends Error {
  constructor(cause: string) {
    super(`The identity service is unavailable: ${cause}`);
    this.name = 'VaultUnavailable';
  }
}

export class VaultRejected extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'VaultRejected';
  }
}

export interface SealedManifestResponse {
  readonly sealed: {
    eventId: string;
    scannerId: string;
    sequence: number;
    generatedAt: number;
    expiresAt: number;
    count: number;
    ciphertext: string;
    iv: string;
    tag: string;
  };
  readonly included: number;
  /** Identities with no template. They go to the resolution desk, named in advance. */
  readonly missingTemplates: readonly string[];
}

export interface VaultClient {
  challenge(): Promise<LivenessChallenge>;
  enrol(input: {
    identityId: string;
    scope: string;
    consentId: string;
    vector: number[];
    liveness: LivenessProof;
  }): Promise<EnrolResult>;
  verify(input: { identityId: string; scope: string; probe: number[] }): Promise<MatchResult>;
  identify(input: { scope: string; probe: number[] }): Promise<MatchResult>;
  forget(input: { identityId: string; reason: string }): Promise<DeletionReceipt>;
  /**
   * Seal a gate manifest. The only call that causes template material to leave
   * the vault, and it leaves as ciphertext bound to one device and one night.
   */
  sealManifest(input: {
    scannerId: string;
    eventId: string;
    scope: string;
    sequence: number;
    expiresAt: number;
    releaseFrom: number;
    credentials: readonly object[];
  }): Promise<SealedManifestResponse>;
  releaseManifestKey(input: {
    scannerId: string;
    eventId: string;
    expiresAt: number;
  }): Promise<{ key: string }>;
}

export function httpVaultClient(baseUrl: string, token?: string): VaultClient {
  const call = async <T>(path: string, body: unknown, method = 'POST'): Promise<T> => {
    let response: Response;
    try {
      response = await fetch(new URL(path, baseUrl), {
        method,
        headers: {
          'content-type': 'application/json',
          ...(token ? { 'x-vault-token': token } : {}),
        },
        ...(method === 'GET' ? {} : { body: JSON.stringify(body ?? {}) }),
      });
    } catch (cause) {
      // A vault that is down must never fail open into "enrolled".
      throw new VaultUnavailable((cause as Error).message);
    }

    const text = await response.text();
    const parsed = text ? (JSON.parse(text) as Record<string, unknown>) : {};

    if (!response.ok) {
      const err = parsed['error'] as { code?: string; message?: string } | undefined;
      throw new VaultRejected(response.status, err?.code ?? 'VAULT_ERROR', err?.message ?? 'The identity service refused the request.');
    }
    return parsed as T;
  };

  return {
    challenge: () => call<LivenessChallenge>('/v1/challenges', {}),
    enrol: (input) => call<EnrolResult>('/v1/enrol', input),
    verify: (input) => call<MatchResult>('/v1/verify', input),
    identify: (input) => call<MatchResult>('/v1/identify', input),
    forget: (input) => call<DeletionReceipt>('/v1/forget', input),
    sealManifest: (input) => call<SealedManifestResponse>('/v1/manifests', input),
    releaseManifestKey: (input) => call<{ key: string }>('/v1/manifest-keys', input),
  };
}
