import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { ApiFailure, api, type Me } from "./api";

export type SessionState =
  | { status: "loading" }
  | { status: "ready"; me: Me }
  | { status: "none" }
  | { status: "expired" }
  | { status: "error"; failure: ApiFailure };

type SessionContext = {
  state: SessionState;
  refresh: () => Promise<void>;
  sessionEnded: () => void;
};

const Context = createContext<SessionContext | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<SessionState>({ status: "loading" });

  const refresh = useCallback(async () => {
    try {
      setState({ status: "ready", me: await api<Me>("/me") });
    } catch (e) {
      if (e instanceof ApiFailure && e.status === 401) {
        setState({ status: e.code === "session_expired" ? "expired" : "none" });
      } else if (e instanceof ApiFailure) {
        setState({ status: "error", failure: e });
      } else throw e;
    }
  }, []);

  const sessionEnded = useCallback(() => setState({ status: "expired" }), []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const value = useMemo(() => ({ state, refresh, sessionEnded }), [state, refresh, sessionEnded]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useSession() {
  const value = useContext(Context);
  if (!value) throw new Error("useSession outside SessionProvider");
  return value;
}

export const can = (me: Me, capability: string) => me.capabilities.includes(capability);
