"use client";

import { useEffect, useState, useCallback } from "react";

export type ClientPrincipal = {
  identityProvider?: string;
  userId?: string;
  userDetails?: string; // email / UPN
  userRoles?: string[];
  claims?: { typ: string; val: string }[];
};

export function useSwaAuth() {
  const [user, setUser] = useState<ClientPrincipal | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      setLoading(true);
      const res = await fetch("/.auth/me", { cache: "no-store" });
      if (!res.ok) {
        setUser(null);
        setLoading(false);
        return;
      }
      const data = await res.json(); // { clientPrincipal?: {...} }
      setUser(data?.clientPrincipal ?? null);
    } catch {
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { user, loading, refresh };
}
