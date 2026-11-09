import { useEffect, useState } from "react";
import { ApiFailure, api, type Summary } from "../api";
import { ErrorCard, SimBadge, Skeleton, StatusChip } from "../components/ui";
import { Link, useRouteFocus } from "../router";
import { useSession } from "../session";
import { AutomationAdmin } from "./automations";
import { SalesforceAdmin } from "./integration";
import { Head, STATUSES, useLoad } from "./shared";

const sum = (o: Record<string, number>) => Object.values(o).reduce((a, b) => a + b, 0);

export function Overview() {
  useRouteFocus("Overview");
  const { state } = useSession();
  const { data, failure, reload } = useLoad<Summary>("/workspace/summary");
  const resetKey = state.status === "ready" && state.me.kind === "guest" ? state.me.expiresAt : "";
  // biome-ignore lint/correctness/useExhaustiveDependencies: a reset changes the expiry
  useEffect(() => reload(), [resetKey, reload]);
  return (
    <>
      <Head title="Overview" route="/app/overview" />
      {failure && <ErrorCard failure={failure} onRetry={reload} />}
      {!data && !failure && <Skeleton label="Loading overview" />}
      {data && (
        <div className="stack">
          <div className="grid cols-4">
            <section className="card kpi">
              <div className="label">Your cases</div>
              <div className="value">{sum(data.workspaceCases)}</div>
              <div className="note">Editable in this workspace</div>
            </section>
            <section className="card kpi">
              <div className="label">Shared sample cases</div>
              <div className="value">{sum(data.templateCases)}</div>
              <div className="note">Read-only</div>
            </section>
          </div>
          <section className="card">
            <header>
              <h2>Cases by status</h2>
              <SimBadge>Synthetic</SimBadge>
            </header>
            <div className="tscroll">
              <table>
                <caption>Counts come from the database for this workspace.</caption>
                <thead>
                  <tr>
                    <th scope="col">Status</th>
                    <th scope="col" className="r">
                      Yours
                    </th>
                    <th scope="col" className="r">
                      Shared
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {STATUSES.map((s) => (
                    <tr key={s}>
                      <th scope="row">
                        <StatusChip status={s} />
                      </th>
                      <td className="r">{data.workspaceCases[s] ?? 0}</td>
                      <td className="r">{data.templateCases[s] ?? 0}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
          <section className="card">
            <h2>Next</h2>
            <p className="muted">
              Start with <Link to="/app/cases">Cases</Link>, then{" "}
              <Link to="/app/reconciliation">Reconciliation</Link>. Other areas say which phase adds
              them.
            </p>
          </section>
        </div>
      )}
    </>
  );
}

const LATER: Record<string, { title: string; phase: string; note: string }> = {
  analytics: {
    title: "Analytics",
    phase: "P6",
    note: "Trends, source freshness and ROI with clear provenance.",
  },
};

export function Later({ area }: { area: string }) {
  const page = LATER[area] ?? { title: "Not built", phase: "a later phase", note: "" };
  useRouteFocus(page.title);
  return (
    <>
      <Head title={page.title} route={`/app/${area}`} />
      <section className="card state-panel">
        <h2>Not built yet</h2>
        <p className="muted">{page.note}</p>
        <p className="small muted">Planned for phase {page.phase}.</p>
      </section>
    </>
  );
}

type AdminStatus = { ownerIdentity: string; identityMode: string; simulated: boolean };

export function Admin() {
  useRouteFocus("Administration");
  const { data, failure, reload } = useLoad<AdminStatus>("/admin/status", { guestPath: false });
  const [signedOut, setSignedOut] = useState(false);
  const [logoutFailure, setLogoutFailure] = useState<ApiFailure | null>(null);
  const logout = async () => {
    setLogoutFailure(null);
    try {
      const { providerLogoutPath } = await api<{ providerLogoutPath: string }>("/admin/logout", {
        method: "POST",
      });
      // Only the provider can end its own session. The double has no provider to visit.
      if (data?.simulated) setSignedOut(true);
      else window.location.assign(providerLogoutPath);
    } catch (e) {
      if (e instanceof ApiFailure) setLogoutFailure(e);
      else throw e;
    }
  };
  return (
    <>
      <Head title="Administration" route="/admin" />
      {failure && <ErrorCard failure={failure} onRetry={reload} />}
      {!data && !failure && <Skeleton label="Loading administration" />}
      {data && (
        <section className="card state-panel">
          <h2>Owner identity</h2>
          <p>{data.ownerIdentity}</p>
          {data.simulated && (
            <p>
              <SimBadge>Local test double</SimBadge> No real identity provider is involved.
            </p>
          )}
          {signedOut ? (
            <p role="status">Signed out here. No provider session exists in this mode.</p>
          ) : (
            <button type="button" onClick={() => void logout()}>
              Sign out
            </button>
          )}
          {logoutFailure && <ErrorCard failure={logoutFailure} />}
        </section>
      )}
      {data && <SalesforceAdmin />}
      {data && <AutomationAdmin />}
    </>
  );
}
