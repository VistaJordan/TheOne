/* Method-specific payout details (Yoda PaymentAddress, D8). One small form per
   method; the shape that goes over the wire is the shared PaymentAddress
   discriminated union. Nothing is required until the operator picks a method
   that needs it, and the help text says what AP will do with it. */

import type { PaymentAddress, PaymentMethod } from '../../api/client';
import { Icon } from '../Icon';

export type AddressDraft = {
  zelle_handle: string;
  bank_name: string;
  routing_number: string;
  account_number: string;
  account_type: 'checking' | 'savings' | '';
  cashtag: string;
  payable_to: string;
  mailing_address: string;
  credit_note: string;
};

export const blankAddress: AddressDraft = {
  zelle_handle: '',
  bank_name: '',
  routing_number: '',
  account_number: '',
  account_type: '',
  cashtag: '',
  payable_to: '',
  mailing_address: '',
  credit_note: '',
};

/** Field-level errors for the chosen method; empty = complete. */
export function addressErrors(method: PaymentMethod, a: AddressDraft): Partial<Record<keyof AddressDraft, string>> {
  const e: Partial<Record<keyof AddressDraft, string>> = {};
  switch (method) {
    case 'zelle':
      if (a.zelle_handle.trim().length < 3) e.zelle_handle = 'Enter the Zelle email or phone';
      break;
    case 'ach':
      if (!/^\d{9}$/.test(a.routing_number.trim())) e.routing_number = 'Routing number is 9 digits';
      if (!/^\d{4,17}$/.test(a.account_number.trim())) e.account_number = 'Account number is 4–17 digits';
      break;
    case 'cashapp':
      if (!/^\$?[A-Za-z][A-Za-z0-9_-]{0,24}$/.test(a.cashtag.trim())) e.cashtag = 'Enter a $cashtag';
      break;
    case 'check':
      if (a.payable_to.trim() === '') e.payable_to = 'Who is the check payable to?';
      if (a.mailing_address.trim().length < 5) e.mailing_address = 'Enter the mailing address';
      break;
    default:
      break;
  }
  return e;
}

export function toPaymentAddress(method: PaymentMethod, a: AddressDraft): PaymentAddress {
  switch (method) {
    case 'zelle':
      return { method, zelle_handle: a.zelle_handle.trim() };
    case 'ach':
      return {
        method,
        bank_name: a.bank_name.trim() || null,
        routing_number: a.routing_number.trim(),
        account_number: a.account_number.trim(),
        account_type: a.account_type === '' ? null : a.account_type,
      };
    case 'cashapp':
      return { method, cashtag: a.cashtag.trim().startsWith('$') ? a.cashtag.trim() : `$${a.cashtag.trim()}` };
    case 'check':
      return { method, payable_to: a.payable_to.trim(), mailing_address: a.mailing_address.trim() };
    default:
      return { method: 'credit', note: a.credit_note.trim() || null };
  }
}

interface Props {
  method: PaymentMethod;
  value: AddressDraft;
  showErrors: boolean;
  onChange: (next: AddressDraft) => void;
}

export function PaymentAddressFields({ method, value, showErrors, onChange }: Props) {
  const errs = showErrors ? addressErrors(method, value) : {};
  const set = (patch: Partial<AddressDraft>) => onChange({ ...value, ...patch });
  const field = (
    key: keyof AddressDraft,
    label: string,
    opts: { placeholder?: string; inputMode?: 'numeric' | 'text' | 'email'; required?: boolean; mono?: boolean } = {},
  ) => (
    <div className={`field${errs[key] ? ' is-error' : ''}`} key={key}>
      <label className="flabel" htmlFor={`addr-${key}`}>
        {label}{' '}
        {opts.required ? <span className="req" aria-hidden="true">*</span> : <span className="opt">(optional)</span>}
      </label>
      <input
        className={`finput${opts.mono ? ' mono' : ''}`}
        id={`addr-${key}`}
        type="text"
        inputMode={opts.inputMode ?? 'text'}
        placeholder={opts.placeholder}
        value={value[key]}
        aria-invalid={errs[key] ? true : undefined}
        onChange={(e) => set({ [key]: e.target.value } as Partial<AddressDraft>)}
      />
      {errs[key] && (
        <p className="ferr">
          <Icon name="alert-circle" size={12} />
          {errs[key]}
        </p>
      )}
    </div>
  );

  switch (method) {
    case 'zelle':
      return <div className="frow">{field('zelle_handle', 'Zelle email or phone', { placeholder: 'tech@example.com or (409) 555-0143', inputMode: 'email', required: true })}</div>;
    case 'ach':
      return (
        <>
          <div className="frow">
            {field('bank_name', 'Bank', { placeholder: 'e.g. Chase' })}
            <div className="field">
              <label className="flabel" htmlFor="addr-account_type">Account type <span className="opt">(optional)</span></label>
              <div className="selwrap">
                <select
                  className="fselect"
                  id="addr-account_type"
                  value={value.account_type}
                  onChange={(e) => set({ account_type: e.target.value as AddressDraft['account_type'] })}
                >
                  <option value="">—</option>
                  <option value="checking">Checking</option>
                  <option value="savings">Savings</option>
                </select>
                <span className="sel-chev" aria-hidden="true"><Icon name="chev-d" size={14} /></span>
              </div>
            </div>
          </div>
          <div className="frow">
            {field('routing_number', 'Routing number', { placeholder: '9 digits', inputMode: 'numeric', required: true, mono: true })}
            {field('account_number', 'Account number', { placeholder: '4–17 digits', inputMode: 'numeric', required: true, mono: true })}
          </div>
          <p className="fhelp">
            <Icon name="lock" size={12} />
            Only AP sees the full account number; everyone else sees the last four digits.
          </p>
        </>
      );
    case 'cashapp':
      return <div className="frow">{field('cashtag', 'Cash App $cashtag', { placeholder: '$gulfcoastrefrig', required: true, mono: true })}</div>;
    case 'check':
      return (
        <>
          <div className="frow">{field('payable_to', 'Payable to', { placeholder: 'Legal name on the check', required: true })}</div>
          <div className="field">
            <label className="flabel" htmlFor="addr-mailing_address">Mailing address <span className="req" aria-hidden="true">*</span></label>
            <textarea
              className="ftext"
              id="addr-mailing_address"
              rows={2}
              placeholder="Street, city, state ZIP"
              value={value.mailing_address}
              aria-invalid={errs.mailing_address ? true : undefined}
              onChange={(e) => set({ mailing_address: e.target.value })}
            />
            {errs.mailing_address && (
              <p className="ferr"><Icon name="alert-circle" size={12} />{errs.mailing_address}</p>
            )}
          </div>
        </>
      );
    default:
      return (
        <div className="frow">
          {field('credit_note', 'Card note', { placeholder: 'Which company card, last four, or who is carrying it' })}
        </div>
      );
  }
}
