import { useCallback, useEffect, useState } from "react";
import { ApiFailure, api } from "../api";
import { useSession } from "../session";

export function useLoad<T>(path: string | null, { guestPath = true } = {}) {
  const { sessionEnded } = useSession();
  const [data, setData] = useState<T | null>(null);
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const [nonce, setNonce] = useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: nonce forces a reload
  useEffect(() => {
    if (!path) return;
    const controller = new AbortController();
    setData(null);
    setFailure(null);
    api<T>(path, { signal: controller.signal })
      .then(setData)
      .catch((e) => {
        if (e instanceof ApiFailure && e.status === 401 && guestPath) sessionEnded();
        else if (e instanceof ApiFailure) setFailure(e);
      });
    return () => controller.abort();
  }, [path, nonce, sessionEnded, guestPath]);

  return { data, failure, reload: useCallback(() => setNonce((n) => n + 1), []) };
}

export const STATUSES = ["Draft", "Intake", "Needs Review", "Ready", "Approved", "Closed"];
export const day = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString(undefined, { dateStyle: "medium" }) : "No date";

export const Head = ({ title, route }: { title: string; route: string }) => (
  <div className="page-head">
    <h1>{title}</h1>
    <span className="route">{route}</span>
  </div>
);
