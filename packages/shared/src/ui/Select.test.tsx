// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createRef, type ChangeEvent } from 'react';

import { Select } from './Select.js';

afterEach(() => {
  cleanup();
});

describe('Select', () => {
  it('associates the label with the control through the id', () => {
    render(
      <Select id="engine" label="Engine" defaultValue="latex">
        <option value="latex">LaTeX</option>
        <option value="typst">Typst</option>
      </Select>,
    );
    const select = screen.getByLabelText('Engine') as HTMLSelectElement;
    expect(select.tagName).toBe('SELECT');
    expect(select.id).toBe('engine');
    expect(select.value).toBe('latex');
  });

  it('falls back to the name for the id, like Input', () => {
    render(
      <Select name="scope" label="Access">
        <option value="read">Read only</option>
      </Select>,
    );
    expect((screen.getByLabelText('Access') as HTMLSelectElement).id).toBe('scope');
  });

  it('calls onChange with the picked option and forwards the ref', () => {
    // Read the value inside the handler: on a controlled select React puts
    // the prop value back once the event has been handled.
    const seen: string[] = [];
    const onChange = vi.fn((e: ChangeEvent<HTMLSelectElement>) => seen.push(e.target.value));
    const ref = createRef<HTMLSelectElement>();
    render(
      <Select ref={ref} label="Access" value="read" onChange={onChange} data-testid="scope">
        <option value="read">Read only</option>
        <option value="write">Read and write</option>
      </Select>,
    );
    const select = screen.getByTestId('scope') as HTMLSelectElement;
    expect(ref.current).toBe(select);
    fireEvent.change(select, { target: { value: 'write' } });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(seen).toEqual(['write']);
  });

  it('renders the hint below the field and no label span without one', () => {
    render(
      <Select hint="Fixed for the life of the token">
        <option>a</option>
      </Select>,
    );
    expect(screen.getByText('Fixed for the life of the token')).toBeTruthy();
    expect(document.querySelectorAll('label > span')).toHaveLength(1);
  });
});
