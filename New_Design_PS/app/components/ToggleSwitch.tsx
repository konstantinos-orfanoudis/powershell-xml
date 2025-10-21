"use client";
import React from "react";

export default function ToggleSwitch({
  checked,
  onChange,
  label,
  id,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label?: string;
  id?: string;
}) {
  const switchId = id || `tgl-${Math.random().toString(36).slice(2)}`;
  return (
    <label htmlFor={switchId} className="inline-flex items-center gap-2 select-none">
      {label && <span className="text-sm text-slate-100/90">{label}</span>}
      <button
        id={switchId}
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={`relative h-6 w-11 rounded-full transition-colors
          ${checked ? "bg-emerald-500" : "bg-slate-500"}
          focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-sky-400 focus:ring-offset-slate-900`}
      >
        <span
          className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform
            ${checked ? "translate-x-5" : "translate-x-0.5"}`}
        />
      </button>
    </label>
  );
}
