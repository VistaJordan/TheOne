/* 0075 · Small pieces shared by the three documents. */

import type { ReactNode } from 'react';

/** Renders **bold** and `code` spans inside a registry string. */
export function Rich({ text }: { text: string }) {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).filter(Boolean);
  return (
    <>
      {parts.map((p, i) => {
        if (p.startsWith('**') && p.endsWith('**')) return <b key={i}>{p.slice(2, -2)}</b>;
        if (p.startsWith('`') && p.endsWith('`')) return <code key={i}>{p.slice(1, -1)}</code>;
        return <span key={i}>{p}</span>;
      })}
    </>
  );
}

/** The blue "Document control" / "NOTE" box of the SOP format. */
export function DocBox({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="doc-box">
      <b className="doc-box-title">{title}</b>
      <div className="doc-box-body">{children}</div>
    </div>
  );
}

export function DocTable({ head, rows, className }: { head: string[]; rows: ReactNode[][]; className?: string }) {
  return (
    <div className={`doc-table-wrap${className ? ` ${className}` : ''}`}>
      <table className="doc-table">
        <thead>
          <tr>
            {head.map((h) => (
              <th key={h}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              {r.map((c, j) => (
                <td key={j}>{c}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

export const fmtDate = (iso: string | null | undefined) => (iso ? iso.slice(0, 10) : '');
export const fmtMoney = (n: number) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
