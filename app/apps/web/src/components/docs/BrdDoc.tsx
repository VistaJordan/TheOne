/* 0075 · The BRD, drawn from the registry (packages/shared/src/docs/brd.ts,
   rules.ts, lifecycle.ts) and the live snapshot. */

import { BRD_PARTS, BUSINESS_RULES, LIFECYCLE, docsVersionLine, type DocsSnapshot } from '@theone/shared';
import { DocBox, DocTable, Rich, fmtDate, fmtMoney, slug } from './DocBits';

export interface TocEntry {
  id: string;
  label: string;
  level: 1 | 2 | 3;
}

/** The table of contents the page draws beside the document. */
export function brdToc(snap: DocsSnapshot | null): TocEntry[] {
  const toc: TocEntry[] = [
    { id: 'brd-intro', label: '1. Introduction', level: 1 },
    { id: 'brd-context', label: '2. Business context', level: 1 },
    { id: 'brd-modules', label: '3. Modules and features', level: 1 },
  ];
  BRD_PARTS.forEach((p, i) => {
    toc.push({ id: `brd-part-${p.key}`, label: `3.${i + 1} ${p.title}`, level: 2 });
    p.modules.forEach((m, j) => toc.push({ id: `brd-mod-${m.key}`, label: `3.${i + 1}.${j + 1} ${m.title}`, level: 3 }));
  });
  toc.push({ id: 'brd-rules', label: '4. Business rules register', level: 1 });
  toc.push({ id: 'brd-live', label: '5. Appendix: the live instance', level: 1 });
  if (snap) {
    ['Instance', 'Contents', 'Statuses and phases', 'Field catalogue', 'Roles', 'Automations', 'Integrations', 'Approval tiers', 'Holidays', 'Dashboards', 'Revision history'].forEach((l, i) =>
      toc.push({ id: `brd-live-${slug(l)}`, label: `5.${i + 1} ${l}`, level: 2 }),
    );
  }
  return toc;
}

export function BrdDoc({ snap }: { snap: DocsSnapshot | null }) {
  return (
    <article className="doc doc-brd">
      <header className="doc-cover">
        <p className="doc-kicker">Business Requirements Document · living</p>
        <h1>The One</h1>
        <p className="doc-sub">Work-order, quote, vendor and payment platform for Seamless FM (Byblos Vista)</p>
        <p className="doc-version">{docsVersionLine(snap)}</p>
        <DocBox title="Document control">
          What the system does and why: every module, every feature, the controls on screen, the rules the system enforces, the permission each action needs and the value each feature brings. Sections 1 to 4 are kept beside the code and reviewed against the screens; section 5 is read from the live instance each time this page opens, so statuses, fields, roles, automations, integrations and the revision history always describe the system as it is today.
        </DocBox>
      </header>

      <section id="brd-intro">
        <h2>1. Introduction</h2>
        <h3>1.1 Purpose</h3>
        <p>
          This document is the contract between the business and the application: it states what The One must do, records how each requirement is met, and names the value each part brings. It is written for stakeholders, reviewers and auditors. The companion SOP says how people operate it; the Lifecycle tab draws the work order&rsquo;s path.
        </p>
        <h3>1.2 How to read it</h3>
        <ul>
          <li><b>What</b> is the behaviour as built. <b>Value</b> is why it matters to Seamless FM. <b>Controls</b> are the labels on screen. <b>Rules</b> are what the system refuses or does by itself. <b>Permissions</b> are the paths the API checks, as they read on the Roles screen. <b>Audit</b> lists the event names written to the log. <b>BRD rules</b> point into the register in section 4.</li>
          <li>A migration number (for example 0036) says which database change introduced a feature; the ledger in section 5 dates it.</li>
          <li>Anything marked <i>deferred</i> is known and chosen, not forgotten.</li>
        </ul>
        <h3>1.3 Scope</h3>
        <p>Everything deployed on phase-0-ground. Out of scope: the Ecotrak inbound sync&rsquo;s internals (a separate module, read-only until go-live), VR - CRM and Tech Locator (still running, untouched, until their data moves), and the client systems themselves.</p>
      </section>

      <section id="brd-context">
        <h2>2. Business context</h2>
        <h3>2.1 The company and the problem</h3>
        <p>
          Seamless FM runs facilities work orders for retail and restaurant clients through external technicians. Work arrives in the clients&rsquo; own systems (Ecotrak, Corrigo, ServiceChannel), by email and by phone. Each job must be accepted, dispatched to a subcontractor, assessed, quoted inside the client&rsquo;s clock, approved by the client, fulfilled, closed with proof, paid on the technician side and invoiced on the client side. Before The One this ran across ClickUp, Teams reminders, a tech-locator map, a vendor CRM, Make and Paperform automations and a tracking spreadsheet per client. The One replaces them with one record and one set of rules.
        </p>
        <h3>2.2 Principles that shaped what was built</h3>
        <ul>
          <li><b>One record, one log.</b> Every fact about a job is on the work order and every change is in one append-only audit log.</li>
          <li><b>Rules as data.</b> Statuses, fields, roles, automations, holidays, tiers, layouts and templates are edited in Admin, not deployed.</li>
          <li><b>Trust is tiered.</b> Probation, standard and senior tiers are real permissions; dispatchers propose, managers decide.</li>
          <li><b>The screen never promises what the server refuses.</b> The same permission resolver runs in the browser and the API; a locked button says why.</li>
          <li><b>Nothing talks to a client system until go-live.</b> Inbound sync is live; the outbound rules are applied and recorded, not sent.</li>
          <li><b>Nothing is deleted.</b> Trash, soft deletes and discarded drafts; corrections are new rows.</li>
        </ul>
        <h3>2.3 The lifecycle the application supports</h3>
        <DocTable
          head={['Stage', 'Who', 'What happens']}
          rows={LIFECYCLE.stages.map((s) => [<b key="t">{s.title}</b>, s.who.join(', '), s.summary])}
        />
        <p className="doc-lead">The Lifecycle tab draws every status, move, gate and side process with live counts.</p>
      </section>

      <section id="brd-modules">
        <h2>3. Modules and features</h2>
        {BRD_PARTS.map((part, pi) => (
          <section key={part.key} id={`brd-part-${part.key}`} className="doc-part">
            <h3>
              3.{pi + 1} {part.title}
            </h3>
            <p className="doc-lead">{part.intro}</p>
            {part.modules.map((m, mi) => (
              <section key={m.key} id={`brd-mod-${m.key}`} className="doc-module">
                <h4>
                  3.{pi + 1}.{mi + 1} {m.title}
                </h4>
                <dl className="doc-kv">
                  <dt>Where</dt>
                  <dd>{m.where}</dd>
                  <dt>Purpose</dt>
                  <dd>{m.purpose}</dd>
                  <dt>Value</dt>
                  <dd>{m.value}</dd>
                  {m.users?.length ? (
                    <>
                      <dt>Users</dt>
                      <dd>{m.users.join(', ')}</dd>
                    </>
                  ) : null}
                </dl>
                {m.features.map((f) => (
                  <div key={f.name} className="doc-feature">
                    <h5>
                      {f.name}
                      {f.since && <span className="doc-since">since {f.since}</span>}
                    </h5>
                    <p>
                      <b>What.</b> <Rich text={f.what} />
                    </p>
                    {f.value && (
                      <p>
                        <b>Value.</b> <Rich text={f.value} />
                      </p>
                    )}
                    {f.controls?.length ? (
                      <DocTable className="doc-controls" head={['On screen', 'What it does']} rows={f.controls.map((c) => [<b key="l">{c.label}</b>, c.does])} />
                    ) : null}
                    {f.rules?.length ? (
                      <div className="doc-rules">
                        <b>Rules.</b>
                        <ul>
                          {f.rules.map((r) => (
                            <li key={r}>{r}</li>
                          ))}
                        </ul>
                      </div>
                    ) : null}
                    <p className="doc-meta">
                      {f.permissions?.length ? (
                        <span>
                          <b>Permissions</b>{' '}
                          {f.permissions.map((p) => (
                            <code key={p}>{p}</code>
                          ))}
                        </span>
                      ) : null}
                      {f.audit?.length ? (
                        <span>
                          <b>Audit</b>{' '}
                          {f.audit.map((p) => (
                            <code key={p}>{p}</code>
                          ))}
                        </span>
                      ) : null}
                      {f.brd?.length ? (
                        <span>
                          <b>BRD rules</b> {f.brd.join(', ')}
                        </span>
                      ) : null}
                    </p>
                    {f.deferred?.length ? (
                      <p className="doc-deferred">
                        <b>Deferred.</b> {f.deferred.join(' ')}
                      </p>
                    ) : null}
                  </div>
                ))}
              </section>
            ))}
          </section>
        ))}
      </section>

      <section id="brd-rules">
        <h2>4. Business rules register</h2>
        <p className="doc-lead">Every numbered rule the system applies, where it is enforced, and its state.</p>
        <DocTable
          head={['Rule', 'Title', 'Statement', 'Enforced', 'State']}
          rows={BUSINESS_RULES.map((r) => [
            <code key="id">{r.id}</code>,
            <b key="t">{r.title}</b>,
            r.statement,
            r.enforced,
            <span key="s" className={`doc-state is-${r.state}`}>
              {r.state}
              {r.note ? <small> · {r.note}</small> : null}
            </span>,
          ])}
        />
      </section>

      <section id="brd-live">
        <h2>5. Appendix: the live instance</h2>
        {!snap ? (
          <p className="doc-lead">The live appendix could not be read.</p>
        ) : (
          <>
            <h3 id="brd-live-instance">5.1 Instance</h3>
            <DocTable
              head={['Setting', 'Value']}
              rows={[
                ['Authentication', snap.instance.auth_mode === 'entra' ? 'Microsoft Entra ID' : 'Development bypass'],
                ['Environment', snap.instance.node_env],
                ['Web origin', snap.instance.web_origin],
                ['Database', snap.instance.database],
                ['Migrations applied', String(snap.instance.migrations_applied)],
                ['Latest migration', snap.instance.latest_migration ?? '—'],
                ['Super admins', snap.super_admins.join(', ')],
                ['Service principals', snap.service_principals.join(', ') || '—'],
              ]}
            />
            <h3 id="brd-live-contents">5.2 Contents</h3>
            <div className="doc-tiles">
              {Object.entries(snap.counts).map(([k, v]) => (
                <div key={k} className="doc-tile">
                  <b>{v.toLocaleString()}</b>
                  <span>{k.replace(/_/g, ' ')}</span>
                </div>
              ))}
            </div>
            <h3 id="brd-live-statuses-and-phases">5.3 Statuses and phases</h3>
            <p className="doc-lead">
              Phase groups: {snap.status_groups.map((g) => `${g.label} (${g.status_count})`).join(' · ')}.
            </p>
            <DocTable
              head={['Status', 'Phase group', 'Lifecycle phase', 'Live work orders', 'Archive']}
              rows={snap.statuses.map((s) => [
                <span key="n" className="doc-status">
                  <i style={{ background: s.color }} /> {s.name}
                </span>,
                s.group,
                s.phase ?? '—',
                String(s.wo_count),
                s.is_archive ? 'yes' : '',
              ])}
            />
            <h3 id="brd-live-field-catalogue">5.4 Field catalogue</h3>
            <DocTable
              head={['Field', 'Type', 'Section', 'Options', 'Add work order', 'In use', 'Notes']}
              rows={snap.fields.map((f) => [
                <b key="l">{f.label}</b>,
                f.type,
                f.section,
                f.options.length ? f.options.join('; ') : '',
                f.create_mode,
                String(f.used_by),
                [f.computed ? 'computed' : '', f.visit_owned ? 'mirrors the latest visit' : ''].filter(Boolean).join(', '),
              ])}
            />
            <h3 id="brd-live-roles">5.5 Roles</h3>
            {snap.roles.map((r) => (
              <div key={r.code} className="doc-role">
                <h4>
                  {r.label} <code>{r.code}</code>
                  {r.is_system && <span className="doc-since">built in</span>}
                  <span className="doc-since">{r.user_count} people</span>
                </h4>
                {r.description && <p>{r.description}</p>}
                <p className="doc-meta">
                  <span>
                    <b>Work orders seen</b> {r.wo_scope === 'everything' ? 'Everything' : 'Only theirs'}
                  </span>
                  <span>
                    <b>Status changes</b> {r.status_mode === 'direct' ? 'Change directly' : r.status_mode === 'request' ? 'Must request' : 'Not allowed'}
                  </span>
                </p>
                <DocTable
                  className="doc-perm"
                  head={['Section', 'View', 'Create', 'Edit', 'Delete', 'Approve']}
                  rows={r.sections.map((s) => [s.label, s.view ? '✓' : '', s.create ? '✓' : '', s.edit ? '✓' : '', s.delete ? '✓' : '', s.approve ? '✓' : ''])}
                />
              </div>
            ))}
            <h3 id="brd-live-automations">5.6 Automations</h3>
            <DocTable head={['Rule', 'State', 'Trigger', 'Conditions', 'Actions', 'Runs']} rows={snap.automations.map((a) => [<b key="n">{a.name}</b>, a.enabled ? 'on' : 'paused', a.trigger, String(a.conditions), a.actions.join('; '), String(a.run_count)])} />
            <h3 id="brd-live-integrations">5.7 Integrations</h3>
            <DocTable head={['Connector', 'Group', 'Switch', 'Built', 'Set up', 'What it does']} rows={snap.integrations.map((i) => [<b key="n">{i.name}</b>, i.group, i.enabled ? 'on' : 'off', i.built ? 'yes' : 'not yet', i.configured ? 'yes' : 'no', i.summary])} />
            <h3 id="brd-live-approval-tiers">5.8 Approval tiers by amount</h3>
            <DocTable head={['Kind', 'Band', 'From', 'Up to', 'Roles']} rows={snap.approval_tiers.map((t) => [t.kind, t.label, fmtMoney(t.min_amount), t.max_amount == null ? 'no ceiling' : fmtMoney(t.max_amount), t.roles.length ? t.roles.join(', ') : 'anyone with the permission'])} />
            <h3 id="brd-live-holidays">5.9 Holidays</h3>
            <DocTable head={['Day', 'Name']} rows={snap.holidays.map((h) => [h.day, h.name])} />
            <h3 id="brd-live-dashboards">5.10 Dashboards</h3>
            <DocTable head={['Dashboard', 'Folder', 'Shipped as', 'Cards']} rows={snap.dashboards.map((d) => [<b key="n">{d.name}</b>, d.folder ?? '', d.system_key ?? '', String(d.widgets)])} />
            <h3 id="brd-live-revision-history">5.11 Revision history</h3>
            <p className="doc-lead">The migration ledger: every change to the schema and the seeded configuration, in order, with the day it was applied to this instance.</p>
            <DocTable head={['#', 'Change', 'Applied']} rows={snap.migrations.map((m) => [<code key="n">{String(m.n).padStart(4, '0')}</code>, m.title, fmtDate(m.applied_at)])} />
          </>
        )}
      </section>
    </article>
  );
}
