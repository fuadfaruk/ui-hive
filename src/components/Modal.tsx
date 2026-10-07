import { useId, useLayoutEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import type { KeyboardEvent, ReactNode } from 'react';
import { Icon } from './Icon';

const dialogs: HTMLDialogElement[] = [];
let previousOverflow = '';

export function isInTopDialog(element: HTMLElement): boolean {
  return dialogs.at(-1)?.contains(element) ?? false;
}

function focusable(dialog: HTMLDialogElement): HTMLElement[] {
  return [...dialog.querySelectorAll<HTMLElement>('button, a[href], input, textarea, select, summary, iframe, [tabindex]')]
    .filter((element) => element.tabIndex >= 0 && !element.matches(':disabled, [data-focus-guard]') &&
      !element.closest('[hidden], [inert]') && element.getClientRects().length > 0);
}

export function isTypingTarget(target: EventTarget | null): boolean {
  return target instanceof Element && !!target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="slider"]');
}

interface ModalProps {
  title: string;
  eyebrow?: string;
  description?: string;
  children: ReactNode;
  onClose: () => void;
  variant?: 'drawer' | 'focus';
  className?: string;
  closeLabel?: string;
  dismissDisabled?: boolean;
  headerActions?: ReactNode;
  onKeyDown?: (event: KeyboardEvent<HTMLDialogElement>) => void;
}

export function Modal({
  title, eyebrow, description, children, onClose, variant = 'drawer', className = '',
  closeLabel = `Close ${title}`, dismissDisabled = false, headerActions, onKeyDown,
}: ModalProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descriptionId = useId();

  useLayoutEffect(() => {
    const dialog = ref.current!;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (!dialogs.length) {
      previousOverflow = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
    }
    dialogs.push(dialog);
    // The native top layer handles inertness, including opaque iframe documents.
    dialog.showModal();
    (dialog.querySelector<HTMLElement>('[data-autofocus]') ?? focusable(dialog)[0] ?? dialog).focus({ preventScroll: true });
    return () => {
      const index = dialogs.indexOf(dialog);
      if (index !== -1) dialogs.splice(index, 1);
      dialog.close();
      if (!dialogs.length) document.body.style.overflow = previousOverflow;
      queueMicrotask(() => {
        const top = dialogs.at(-1);
        if (previousFocus?.isConnected && !previousFocus.matches(':disabled') && (!top || top.contains(previousFocus))) {
          previousFocus.focus({ preventScroll: true });
        } else if (top) {
          (focusable(top)[0] ?? top).focus({ preventScroll: true });
        } else {
          document.querySelector<HTMLElement>('[data-composer-input]')?.focus({ preventScroll: true });
        }
      });
    };
  }, []);

  function edgeFocus(last: boolean) {
    const dialog = ref.current;
    if (!dialog || dialogs.at(-1) !== dialog) return;
    const elements = focusable(dialog);
    (last ? elements.at(-1) : elements[0])?.focus({ preventScroll: true });
  }

  return createPortal(
    <dialog ref={ref} className={`modal modal-${variant} ${className}`} aria-labelledby={titleId}
      aria-describedby={description ? descriptionId : undefined} aria-modal="true" tabIndex={-1}
      onCancel={(event) => { event.preventDefault(); if (!dismissDisabled) onClose(); }}
      onClick={(event) => {
        if (event.target !== event.currentTarget || dismissDisabled) return;
        const rect = event.currentTarget.getBoundingClientRect();
        if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) onClose();
      }}
      onKeyDown={(event) => {
        if (dialogs.at(-1) !== ref.current) return;
        onKeyDown?.(event);
        if (event.defaultPrevented || event.key !== 'Tab' || !ref.current) return;
        const elements = focusable(ref.current);
        if (!elements.length) { event.preventDefault(); ref.current.focus(); return; }
        if (event.shiftKey && (document.activeElement === elements[0] || document.activeElement === ref.current)) {
          event.preventDefault(); elements.at(-1)?.focus();
        } else if (!event.shiftKey && document.activeElement === elements.at(-1)) {
          event.preventDefault(); elements[0].focus();
        }
      }}>
      <span className="focus-guard" data-focus-guard tabIndex={0} onFocus={() => edgeFocus(true)} />
      <header className="modal-header">
        <div className="modal-heading">
          {eyebrow && <p className="eyebrow">{eyebrow}</p>}
          <h2 id={titleId}>{title}</h2>
          {description && <p id={descriptionId} className="modal-description">{description}</p>}
        </div>
        <div className="modal-header-actions">
          {headerActions}
          <button className={variant === 'focus' ? 'button button-subtle' : 'icon-button'} type="button"
            aria-label={closeLabel} title={closeLabel} disabled={dismissDisabled} onClick={onClose}>
            <Icon name={variant === 'focus' ? 'grid' : 'close'} />
            {variant === 'focus' && <span>Grid View</span>}
          </button>
        </div>
      </header>
      {children}
      <span className="focus-guard" data-focus-guard tabIndex={0} onFocus={() => edgeFocus(false)} />
    </dialog>,
    document.body,
  );
}
