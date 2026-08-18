export const transientIdleGracePeriod = 900;

export function liveTrackIdentity(source, title) {
  return `${String(source ?? "unknown")}:${String(title ?? "")
    .normalize("NFKC")
    .trim()
    .toLocaleLowerCase()}`;
}

export function shouldHoldIncomingTrack(currentIdentity, nextIdentity, artworkPending) {
  return Boolean(currentIdentity && currentIdentity !== nextIdentity && artworkPending);
}
