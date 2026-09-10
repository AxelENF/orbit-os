"use client";

import { useEffect, useState } from "react";

import { hasSupabaseBrowserConfig } from "@/lib/supabase/client";

export function RuntimeMode() {
  const [label, setLabel] = useState(() => (hasSupabaseBrowserConfig() ? "Verificando sesión" : "Demo local"));

  useEffect(() => {
    if (!hasSupabaseBrowserConfig()) return;
    fetch("/api/content", { credentials: "same-origin" })
      .then((response) => {
        if (response.status === 401) setLabel("Inicia sesión");
        else if (response.ok) setLabel("Supabase conectado");
        else setLabel("Supabase no disponible");
      })
      .catch(() => setLabel("Supabase no disponible"));
  }, []);

  return <p className="mt-2 text-sm font-semibold text-white">{label}</p>;
}
