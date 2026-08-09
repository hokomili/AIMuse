import { useEffect, useRef, useState, type ComponentProps } from 'react';

type TextProps = Omit<ComponentProps<'input'>, 'value' | 'defaultValue' | 'onChange' | 'onBlur' | 'onKeyDown' | 'type'> & {
  value: string;
  onCommit(value: string): void;
};

export function CommitTextInput({ value, onCommit, ...props }: TextProps) {
  const [draft, setDraft] = useState(value);
  const draftRef = useRef(value);
  const editing = useRef(false);
  useEffect(() => {
    if (!editing.current) {
      draftRef.current = value;
      // A committed engine snapshot is an external value for this draft field.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setDraft(value);
    }
  }, [value]);

  const reset = () => {
    draftRef.current = value;
    setDraft(value);
  };
  const commit = () => {
    const next = draftRef.current;
    if (next !== value) onCommit(next);
  };

  return <input {...props} value={draft} onFocus={(event) => { editing.current = true; props.onFocus?.(event); }} onChange={(event) => { draftRef.current = event.target.value; setDraft(event.target.value); }} onBlur={() => { editing.current = false; commit(); }} onKeyDown={(event) => {
    if (event.key === 'Enter') event.currentTarget.blur();
    if (event.key === 'Escape') { reset(); event.currentTarget.blur(); }
  }} />;
}

type NumberProps = Omit<ComponentProps<'input'>, 'value' | 'defaultValue' | 'onChange' | 'onBlur' | 'onKeyDown' | 'type'> & {
  value: number;
  onCommit(value: number): void;
};

export function CommitNumberInput({ value, onCommit, min, max, ...props }: NumberProps) {
  const [draft, setDraft] = useState(String(value));
  const draftRef = useRef(String(value));
  const editing = useRef(false);
  useEffect(() => {
    if (!editing.current) {
      draftRef.current = String(value);
      // A committed engine snapshot is an external value for this draft field.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setDraft(String(value));
    }
  }, [value]);

  const reset = () => {
    draftRef.current = String(value);
    setDraft(String(value));
  };
  const commit = () => {
    const parsed = Number(draftRef.current);
    if (!Number.isFinite(parsed)) { reset(); return; }
    const minimum = typeof min === 'number' ? min : -Infinity;
    const maximum = typeof max === 'number' ? max : Infinity;
    const next = Math.max(minimum, Math.min(maximum, parsed));
    draftRef.current = String(next);
    setDraft(String(next));
    if (next !== value) onCommit(next);
  };

  return <input {...props} type="number" min={min} max={max} value={draft} onFocus={(event) => { editing.current = true; props.onFocus?.(event); }} onChange={(event) => { draftRef.current = event.target.value; setDraft(event.target.value); }} onBlur={() => { editing.current = false; commit(); }} onKeyDown={(event) => {
    if (event.key === 'Enter') event.currentTarget.blur();
    if (event.key === 'Escape') { reset(); event.currentTarget.blur(); }
  }} />;
}

type RangeProps = Omit<ComponentProps<'input'>, 'value' | 'defaultValue' | 'onChange' | 'onBlur' | 'onKeyUp' | 'onPointerDown' | 'onPointerUp' | 'type'> & {
  value: number;
  onCommit(value: number): void;
};

export function CommitRange({ value, onCommit, ...props }: RangeProps) {
  const [draft, setDraft] = useState(value);
  const draftRef = useRef(value);
  const dragging = useRef(false);
  useEffect(() => {
    if (!dragging.current) {
      draftRef.current = value;
      // A committed engine snapshot is an external value for this draft field.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setDraft(value);
    }
  }, [value]);

  const commit = () => {
    if (draftRef.current !== value) onCommit(draftRef.current);
  };

  return <input {...props} type="range" value={draft} onChange={(event) => { const next = Number(event.target.value); draftRef.current = next; setDraft(next); }} onPointerDown={() => { dragging.current = true; }} onPointerUp={() => { dragging.current = false; commit(); }} onKeyUp={commit} onBlur={() => { dragging.current = false; commit(); }} />;
}
