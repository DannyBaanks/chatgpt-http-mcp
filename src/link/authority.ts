// src/link/authority.ts — Modelo de autoridad por peer (`office` vs `compute`, fail-closed).
//
// Mismo principio que REMOTE_AUTHORITY en munder-link:
//   - Emparejar por SAS de 6 dígitos solo concede `office: true, compute: false`.
//   - Ejecutar procesos directos (`job_*`) exige opt-in explícito del operador local
//     en la máquina receptora (`isymcp link compute allow <peer>`).
import { LinkError, type LinkPeer, type PeerAuthority } from "./crypto";
import { appendReceipt, defaultLinkDir, findPeer, loadPeers, savePeers } from "./store";

export function peerAuthority(peer: LinkPeer | null | undefined): PeerAuthority {
  return {
    office: peer?.authority?.office !== false,
    compute: peer?.authority?.compute === true,
  };
}

export function peerHasCompute(peer: LinkPeer | null | undefined): boolean {
  return peerAuthority(peer).compute;
}

export function requireComputeAuthority(peer: LinkPeer): void {
  if (!peerHasCompute(peer)) {
    throw new LinkError(
      "compute_denied",
      `el peer «${peer.name}» no tiene permiso de cómputo directo; el operador local debe habilitarlo con \`isymcp link compute allow ${peer.name}\``,
      403,
    );
  }
}

export function setPeerComputeAuthority(
  query: string,
  allow: boolean,
  dir = defaultLinkDir(),
): { peer: LinkPeer; authority: PeerAuthority } | null {
  const peers = loadPeers(dir);
  const hit = findPeer(query, peers);
  if (!hit) return null;
  const nextAuth: PeerAuthority = {
    office: hit.authority?.office !== false,
    compute: allow,
  };
  peers[hit.office_id] = { ...hit, authority: nextAuth };
  savePeers(peers, dir);
  appendReceipt(dir, {
    event: allow ? "compute_allowed" : "compute_revoked",
    peer_office_id: hit.office_id,
    peer_name: hit.name,
  });
  return { peer: peers[hit.office_id]!, authority: nextAuth };
}
