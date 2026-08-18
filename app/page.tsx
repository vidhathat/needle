function RecordMark() {
  return (
    <span className="needle-mark" aria-hidden="true">
      <i />
    </span>
  );
}

export default function LandingPage() {
  return (
    <main className="needle-home" id="top">
      <header className="needle-hero">
        <div className="needle-hero-copy">
          <p className="needle-overline">Turntable wallpaper for macOS</p>
          <h1>Needle</h1>
          <div className="needle-actions">
            <a className="needle-primary" href="/download/" download="Needle.dmg">
              Download for Mac
            </a>
            <a className="needle-secondary" href="/player/">Try player</a>
          </div>
          <p className="needle-requirement">Apple silicon · macOS 13+ · Developer ID signed</p>
        </div>

        <div className="needle-product" aria-label="Needle turntable running on a Mac desktop">
          <div className="needle-window-bar" aria-hidden="true">
            <span /><span /><span />
            <b>Needle</b>
          </div>
          <div className="needle-product-screen">
            <iframe src="/landing-player/" title="Interactive preview of the Needle turntable" loading="eager" />
          </div>
          <a className="needle-product-mobile-link" href="/player/">
            Open the interactive player <span aria-hidden="true">↗</span>
          </a>
        </div>

        <p className="needle-services" aria-label="Supported music services">
          <span>Apple Music</span><i />
          <span>Spotify</span><i />
          <span>YouTube Music</span>
        </p>
      </header>

      <footer className="needle-footer">
        <a className="needle-logo" href="#top"><RecordMark /><span>Needle</span></a>
        <p className="needle-privacy-note">
          Playback stays local. For sharper covers, Needle sends only the current title and artist
          to public artwork catalogs—never audio or account credentials.
        </p>
        <a href="/player/">Interactive preview ↗</a>
      </footer>
    </main>
  );
}
