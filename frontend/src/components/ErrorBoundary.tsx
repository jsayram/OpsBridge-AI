import { Component, type ReactNode } from "react";

// Last resort for a render failure. The reference ties a screenshot to a console entry.
export class ErrorBoundary extends Component<
  { children: ReactNode },
  { reference: string | null }
> {
  override state = { reference: null as string | null };

  static getDerivedStateFromError() {
    return { reference: crypto.randomUUID() };
  }

  override componentDidCatch(error: Error) {
    console.error(JSON.stringify({ event: "render_error", name: error.name }));
  }

  override render() {
    if (!this.state.reference) return this.props.children;
    return (
      <main className="page" id="main" tabIndex={-1}>
        <section className="card state-panel" role="alert">
          <h1>Something went wrong on this page</h1>
          <p className="muted">Reloading usually fixes it. Your demo data is safe on the server.</p>
          <p className="small muted">
            Reference: <span className="mono">{this.state.reference}</span>
          </p>
          <button type="button" onClick={() => window.location.reload()}>
            Reload
          </button>
        </section>
      </main>
    );
  }
}
