// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

import { Button, buttonClass } from './Button.js';

afterEach(() => {
  cleanup();
});

describe('Button sizes', () => {
  it('md is the default and carries the chrome padding and text size', () => {
    render(<Button>Save</Button>);
    const cls = screen.getByRole('button', { name: 'Save' }).className;
    expect(cls).toContain('px-3.5');
    expect(cls).toContain('py-1.5');
    expect(cls).toContain('text-sm');
  });

  it('sm and xs step the padding and type down together', () => {
    const { unmount } = render(<Button size="sm">Reply</Button>);
    const sm = screen.getByRole('button', { name: 'Reply' }).className;
    expect(sm).toContain('px-2');
    expect(sm).toContain('py-1');
    expect(sm).toContain('text-xs');
    expect(sm).not.toContain('text-sm');
    unmount();

    render(<Button size="xs">Restore all</Button>);
    const xs = screen.getByRole('button', { name: 'Restore all' }).className;
    expect(xs).toContain('px-1.5');
    expect(xs).toContain('py-0.5');
    expect(xs).toContain('text-[10px]');
  });

  it('never emits two text sizes on one element, including the mono variant', () => {
    for (const variant of ['primary', 'ghost', 'danger', 'mono'] as const) {
      for (const size of ['md', 'sm', 'xs'] as const) {
        const textSizes = buttonClass(variant, size)
          .split(' ')
          .filter((c) => /^text-(sm|xs|\[\d+px\])$/.test(c));
        expect(textSizes, `${variant}/${size}`).toHaveLength(1);
      }
    }
  });
});

describe('Button variants', () => {
  it('danger uses the danger tokens; ghost and mono stay outlined', () => {
    render(
      <>
        <Button variant="danger">Delete</Button>
        <Button variant="ghost">Cancel</Button>
        <Button variant="mono">files</Button>
      </>,
    );
    expect(screen.getByRole('button', { name: 'Delete' }).className).toContain('bg-btn-danger');
    expect(screen.getByRole('button', { name: 'Cancel' }).className).toContain(
      'border-hairline-strong',
    );
    const mono = screen.getByRole('button', { name: 'files' }).className;
    expect(mono).toContain('font-mono');
    expect(mono).toContain('uppercase');
  });

  it('defaults to type="button" and forwards the rest', () => {
    render(
      <Button data-testid="b" disabled>
        Go
      </Button>,
    );
    const b = screen.getByTestId('b') as HTMLButtonElement;
    expect(b.type).toBe('button');
    expect(b.disabled).toBe(true);
  });
});

describe('buttonClass', () => {
  it('returns exactly the class list the rendered Button carries', () => {
    for (const variant of ['primary', 'ghost', 'danger', 'mono'] as const) {
      for (const size of ['md', 'sm', 'xs'] as const) {
        const { unmount } = render(
          <Button variant={variant} size={size} className="w-full">
            x
          </Button>,
        );
        expect(screen.getByRole('button', { name: 'x' }).className).toBe(
          buttonClass(variant, size, 'w-full'),
        );
        unmount();
      }
    }
  });

  it('trims when no extra class is given', () => {
    expect(buttonClass('ghost', 'sm')).not.toMatch(/\s$/);
  });
});
