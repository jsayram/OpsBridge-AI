import { type MouseEvent, type ReactNode, useEffect, useSyncExternalStore } from "react";

const listeners = new Set<() => void>();
const notify = () => {
  for (const l of listeners) l();
};

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  window.addEventListener("popstate", listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("popstate", listener);
  };
};

export const usePath = () => useSyncExternalStore(subscribe, () => window.location.pathname);

export function navigate(path: string, state?: unknown) {
  window.history.pushState(state ?? null, "", path);
  notify();
}

export function Link({
  to,
  children,
  className,
  current,
}: {
  to: string;
  children: ReactNode;
  className?: string;
  current?: boolean;
}) {
  const onClick = (e: MouseEvent<HTMLAnchorElement>) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
    e.preventDefault();
    navigate(to);
  };
  return (
    <a
      href={to}
      onClick={onClick}
      {...(className ? { className } : {})}
      {...(current ? { "aria-current": "page" as const } : {})}
    >
      {children}
    </a>
  );
}

let initialLoad = true;

// A new route gets a title and moves focus to its main region, so keyboard and screen
// reader users land on the new content rather than on a link that no longer matters.
export function useRouteFocus(title: string) {
  useEffect(() => {
    document.title = `${title} - OpsBridge AI`;
    // A fresh page load keeps the browser's own focus start, so Tab reaches the skip link.
    if (initialLoad) {
      initialLoad = false;
      return;
    }
    const main = document.getElementById("main");
    if (main && document.activeElement?.tagName !== "SELECT") main.focus({ preventScroll: true });
    window.scrollTo(0, 0);
  }, [title]);
}
