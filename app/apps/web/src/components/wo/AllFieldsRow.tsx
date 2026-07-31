import { Icon } from '../Icon';

interface AllFieldsRowProps {
  count: number;
  onOpen: () => void;
}

/** The rail's drawer row — jumps to the "All fields" tab. */
export function AllFieldsRow({ count, onOpen }: AllFieldsRowProps) {
  return (
    <button type="button" className="allfields" onClick={onOpen}>
      <Icon name="list" size={14} />
      All fields <span className="n">({count})</span>
      <Icon name="chev-r" size={14} className="ic-chev" />
    </button>
  );
}
