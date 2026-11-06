import { ErrorBoundary } from "./components/ErrorBoundary";
import { Shell } from "./components/Shell";
import { ErrorCard, SessionNotice, Skeleton } from "./components/ui";
import { Admin, CaseDetail, Cases, Later, Overview } from "./pages/app";
import { Demo, Engineering, Landing, NotFoundPage } from "./pages/public";
import { usePath } from "./router";
import { SessionProvider, useSession } from "./session";

function AppArea({ path }: { path: string }) {
  const { state, refresh } = useSession();
  const me = state.status === "ready" ? state.me : null;
  const [, , section, id] = path.split("/");
  let body: React.ReactNode;
  if (state.status === "loading") body = <Skeleton label="Loading your session" />;
  else if (state.status === "none") body = <SessionNotice expired={false} />;
  else if (state.status === "expired") body = <SessionNotice expired />;
  else if (state.status === "error") {
    body = <ErrorCard failure={state.failure} onRetry={() => void refresh()} />;
  } else if (section === "overview") body = <Overview />;
  else if (section === "cases" && id) body = <CaseDetail id={id} />;
  else if (section === "cases") body = <Cases />;
  else body = <Later area={section ?? ""} />;
  return (
    <Shell path={path} me={me}>
      {body}
    </Shell>
  );
}

function AdminArea({ path }: { path: string }) {
  return (
    <Shell path={path} me={null}>
      <Admin />
    </Shell>
  );
}

function Routes() {
  const path = usePath();
  if (path === "/") return <Landing />;
  if (path === "/about/engineering") return <Engineering />;
  if (path === "/admin" || path.startsWith("/admin/")) {
    return (
      <SessionProvider>
        <AdminArea path={path} />
      </SessionProvider>
    );
  }
  if (path === "/demo" || path.startsWith("/app/")) {
    return (
      <SessionProvider>{path === "/demo" ? <Demo /> : <AppArea path={path} />}</SessionProvider>
    );
  }
  return <NotFoundPage />;
}

export const App = () => (
  <ErrorBoundary>
    <Routes />
  </ErrorBoundary>
);
