"use client";

import type { CompositeOptions, Corner } from "@/lib/logo-studio/compose";

const CORNER_LABELS: Record<Corner, string> = {
  "top-left": "Superior izquierda",
  "top-right": "Superior derecha",
  "bottom-left": "Inferior izquierda",
  "bottom-right": "Inferior derecha",
};

export function CompositeControls({ value, onChange }: { value: CompositeOptions; onChange: (next: CompositeOptions) => void }) {
  return (
    <fieldset>
      <legend>Posición del logo</legend>
      {(Object.keys(CORNER_LABELS) as Corner[]).map((corner) => (
        <label key={corner}>
          <input
            type="radio"
            name="corner"
            checked={value.corner === corner}
            onChange={() => onChange({ ...value, corner })}
          />
          {CORNER_LABELS[corner]}
        </label>
      ))}
      <label htmlFor="size-percent">Tamaño
        <input id="size-percent" type="range" min={5} max={40} value={value.sizePercent} onChange={(event) => onChange({ ...value, sizePercent: Number(event.target.value) })} />
      </label>
      <label htmlFor="margin-percent">Margen
        <input id="margin-percent" type="range" min={0} max={10} value={value.marginPercent} onChange={(event) => onChange({ ...value, marginPercent: Number(event.target.value) })} />
      </label>
    </fieldset>
  );
}
