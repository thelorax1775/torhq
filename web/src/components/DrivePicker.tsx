/**
 * Drive pickers. Content is placed by drive (the 1TB, the 4TB, the 4TB-x2), so
 * every destination choice leads with the drive's name and keeps the exact
 * path beside it for anyone who needs to know which folder that is.
 */
import { bytes } from "../lib/format.js";
import { SelectField } from "./ui.js";

export interface DriveRef { id: string; label: string }

export interface DriveRoot { id: number; path: string; freeSpace?: number; drive?: DriveRef }

/**
 * Choose an *arr root folder by drive. A configured drive the *arr has no root
 * folder on is listed but disabled, so a missing 1TB option explains itself
 * instead of looking like a bug.
 */
export function RootDriveSelect({ roots, drives, value, onChange, service }: {
  roots: DriveRoot[];
  drives: DriveRef[];
  value: string;
  onChange: (path: string) => void;
  service: string;
}) {
  const missing = drives.filter((d) => !roots.some((r) => r.drive?.id === d.id));
  return (
    <SelectField label="Drive" value={value} onChange={(e) => onChange(e.target.value)}>
      {roots.map((r) => (
        <option key={r.id} value={r.path}>
          {r.drive ? `${r.drive.label} — ` : ""}{r.path}{r.freeSpace != null ? ` · ${bytes(r.freeSpace)} free` : ""}
        </option>
      ))}
      {missing.map((d) => (
        <option key={`missing-${d.id}`} value={`missing-${d.id}`} disabled>
          {d.label} — {service} has no root folder on this drive
        </option>
      ))}
    </SelectField>
  );
}
