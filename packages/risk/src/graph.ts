/**
 * Finding the farm rather than the bot.
 *
 * The inline scorer answers "is this request automated" in fifty milliseconds.
 * This answers a different and slower question: "which of last week's accounts
 * were the same operator". Its answer arrives far too late to block the purchase
 * it describes — and in time to reprice every account in the cluster before the
 * next onsale, which is the point.
 *
 * The graph is accounts joined by things an operator finds expensive to vary:
 * a device fingerprint, a payment instrument, a network. Anything cheap to vary
 * — an email address, a name, a shipping address — is deliberately not an edge,
 * because a cluster built on cheap signals is a cluster of coincidences.
 */

export type EdgeKind = 'device' | 'card' | 'asn' | 'dedupe';

export interface Edge {
  readonly a: string;
  readonly b: string;
  readonly kind: EdgeKind;
}

export interface Observation {
  readonly identityId: string;
  readonly deviceFingerprint?: string;
  readonly cardFingerprint?: string;
  readonly asn?: number;
  /** Biometric dedupe link from the vault. The strongest edge available. */
  readonly dedupeMatchedIdentity?: string;
}

/**
 * How much each kind of shared attribute counts towards suspicion.
 *
 * A shared ASN is nearly worthless on its own — an entire university or mobile
 * carrier shares one — so it scores low and exists mainly to corroborate.
 * A biometric dedupe link is one person on two accounts and scores accordingly.
 */
export const EDGE_WEIGHTS: Readonly<Record<EdgeKind, number>> = Object.freeze({
  dedupe: 10,
  card: 6,
  device: 4,
  asn: 0.5,
});

export interface Cluster {
  readonly id: string;
  readonly identities: readonly string[];
  readonly size: number;
  readonly edgeCounts: Readonly<Record<EdgeKind, number>>;
  /** Higher means more likely one operator. Not a probability. */
  readonly score: number;
  /** Set when the cluster is large or tightly bound enough to act on. */
  readonly suspicious: boolean;
}

class UnionFind {
  #parent = new Map<string, string>();

  find(x: string): string {
    const parent = this.#parent.get(x);
    if (parent === undefined) {
      this.#parent.set(x, x);
      return x;
    }
    if (parent === x) return x;
    const root = this.find(parent);
    this.#parent.set(x, root); // path compression
    return root;
  }

  union(a: string, b: string): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.#parent.set(ra, rb);
  }
}

/**
 * Build edges from raw observations.
 *
 * Two accounts sharing an attribute get one edge of that kind. An attribute
 * shared by an implausible number of accounts is dropped entirely rather than
 * connecting everything to everything — a corporate NAT or a shared library
 * computer would otherwise merge a whole campus into one "farm".
 */
export function buildEdges(observations: readonly Observation[], maxFanout = 50): Edge[] {
  const byAttribute = new Map<string, Set<string>>();
  const add = (kind: EdgeKind, value: string | number | undefined, identity: string) => {
    if (value === undefined) return;
    const key = `${kind}:${value}`;
    const set = byAttribute.get(key) ?? new Set<string>();
    set.add(identity);
    byAttribute.set(key, set);
  };

  const edges: Edge[] = [];
  for (const o of observations) {
    add('device', o.deviceFingerprint, o.identityId);
    add('card', o.cardFingerprint, o.identityId);
    add('asn', o.asn, o.identityId);
    if (o.dedupeMatchedIdentity) {
      edges.push({ a: o.identityId, b: o.dedupeMatchedIdentity, kind: 'dedupe' });
    }
  }

  for (const [key, identities] of byAttribute) {
    if (identities.size < 2) continue;
    // A shared attribute with hundreds of accounts is infrastructure, not a
    // farm. Connecting them all would produce one giant useless cluster.
    if (identities.size > maxFanout) continue;

    const kind = key.split(':')[0] as EdgeKind;
    const list = [...identities];
    for (let i = 0; i < list.length; i += 1) {
      for (let j = i + 1; j < list.length; j += 1) {
        edges.push({ a: list[i] as string, b: list[j] as string, kind });
      }
    }
  }

  return edges;
}

export interface ClusterOptions {
  /** Clusters at or above this size are flagged regardless of score. */
  readonly minSuspiciousSize?: number;
  /** Score at or above this is flagged even for a small cluster. */
  readonly minSuspiciousScore?: number;
}

export function cluster(edges: readonly Edge[], options: ClusterOptions = {}): Cluster[] {
  const minSize = options.minSuspiciousSize ?? 5;
  const minScore = options.minSuspiciousScore ?? 12;

  const uf = new UnionFind();
  for (const e of edges) uf.union(e.a, e.b);

  const members = new Map<string, Set<string>>();
  const counts = new Map<string, Record<EdgeKind, number>>();

  for (const e of edges) {
    const root = uf.find(e.a);
    const set = members.get(root) ?? new Set<string>();
    set.add(e.a);
    set.add(e.b);
    members.set(root, set);

    const c = counts.get(root) ?? { dedupe: 0, card: 0, device: 0, asn: 0 };
    c[e.kind] += 1;
    counts.set(root, c);
  }

  const clusters: Cluster[] = [];
  for (const [root, identities] of members) {
    const edgeCounts = counts.get(root) ?? { dedupe: 0, card: 0, device: 0, asn: 0 };
    const score = (Object.entries(edgeCounts) as Array<[EdgeKind, number]>).reduce(
      (total, [kind, n]) => total + n * EDGE_WEIGHTS[kind],
      0,
    );
    const list = [...identities].sort();
    clusters.push({
      id: `cls_${root}`,
      identities: list,
      size: list.length,
      edgeCounts,
      score,
      suspicious: list.length >= minSize || score >= minScore,
    });
  }

  return clusters.sort((a, b) => b.score - a.score);
}

/**
 * Turn clusters into a per-identity risk multiplier.
 *
 * Applied to the inline score at the *next* onsale, not this one. That is the
 * whole shape of this defence: the graph model cannot save the purchase it
 * describes, only the ones after it.
 */
export function riskMultipliers(clusters: readonly Cluster[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const c of clusters) {
    if (!c.suspicious) continue;
    // Grows with cluster size but flattens, so a hundred-account farm is not
    // scored a hundred times worse than a ten-account one — both are farms.
    const multiplier = 1 + Math.min(2, Math.log2(c.size) / 2);
    for (const identity of c.identities) {
      out.set(identity, Math.max(out.get(identity) ?? 1, multiplier));
    }
  }
  return out;
}
