import type { InputManager } from '../input/input';
import type { FrameInput } from '../input/types';

interface LeaveRequest {
  title: string;
  message: string;
  action: string;
  valid: () => boolean;
  cancel: () => void;
  confirm: () => void;
}

/** A native modal keeps pointer, touch and keyboard focus inside the two choices. */
export class LeaveConfirmation {
  private readonly dialog = document.createElement('dialog');
  private readonly title = document.createElement('h2');
  private readonly message = document.createElement('p');
  private readonly keep = document.createElement('button');
  private readonly leave = document.createElement('button');
  private request: LeaveRequest | null = null;
  private directionHeld = false;
  private directionsReleased = false;

  constructor(
    container: HTMLElement,
    private readonly input: InputManager,
    private readonly fullscreenEscapeGuarded: () => boolean = () => false,
  ) {
    this.dialog.id = 'leaveConfirmation';
    this.dialog.setAttribute('aria-labelledby', 'leaveConfirmationTitle');
    this.dialog.setAttribute('aria-describedby', 'leaveConfirmationMessage');
    this.title.id = 'leaveConfirmationTitle';
    this.message.id = 'leaveConfirmationMessage';
    this.keep.id = 'keepPlaying';
    this.keep.textContent = 'Keep playing';
    this.keep.autofocus = true;
    this.leave.id = 'confirmLeave';
    for (const button of [this.keep, this.leave]) {
      button.type = 'button';
      button.className = 'menu-button';
    }
    this.leave.classList.add('danger');
    this.keep.addEventListener('click', () => this.cancel());
    this.leave.addEventListener('click', () => this.confirm());
    const choices = document.createElement('div');
    choices.className = 'leave-confirmation-choices';
    choices.append(this.keep, this.leave);
    this.dialog.append(this.title, this.message, choices);
    container.appendChild(this.dialog);
    this.dialog.addEventListener('cancel', (event) => {
      event.preventDefault();
      this.input.consumeKeyUntilRelease('Escape');
      // Native Escape may exit fullscreen and dispatch dialog cancel together.
      // Keep the session menu/modal intact until a fresh Escape outside that transition.
      if (this.fullscreenEscapeGuarded()) return;
      this.cancel();
    });
    this.dialog.addEventListener('keydown', (event) => {
      if (event.code === 'Tab') {
        this.input.consumeKeyUntilRelease(event.code);
        event.stopPropagation(); // Keep native Tab / Shift+Tab and the modal focus trap.
        return;
      }
      if (!['Enter', 'Space', 'Backspace', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.code)) return;
      event.preventDefault();
      event.stopPropagation();
      this.input.consumeKeyUntilRelease(event.code);
      if (event.repeat) return;
      if (event.code === 'Backspace') this.cancel();
      else if (event.code.startsWith('Arrow')) {
        (event.code === 'ArrowLeft' || event.code === 'ArrowUp' ? this.keep : this.leave).focus();
      } else if (document.activeElement === this.leave) this.confirm();
      else this.cancel();
    });
  }

  get open(): boolean { return this.request !== null; }

  show(request: LeaveRequest): void {
    if (this.open || !request.valid()) return;
    this.request = request;
    this.title.textContent = request.title;
    this.message.textContent = request.message;
    this.leave.textContent = request.action;
    this.directionHeld = false;
    this.directionsReleased = false;
    this.input.consumeMenuAcceptUntilRelease();
    this.input.consumeMenuBackUntilRelease();
    this.dialog.showModal();
    this.keep.focus();
  }

  validate(): void {
    if (this.request && !this.request.valid()) this.invalidate();
  }

  invalidate(): void {
    this.request = null;
    if (this.dialog.open) this.dialog.close();
  }

  cancel(): void {
    const request = this.request;
    if (!request) return;
    const valid = request.valid();
    this.input.consumeMenuAcceptUntilRelease();
    this.input.consumeMenuBackUntilRelease();
    this.invalidate();
    if (valid) request.cancel();
  }

  private confirm(): void {
    const request = this.request;
    if (!request) return;
    const valid = request.valid();
    // Clear before invoking the callback so duplicate click/accept events cannot leave twice.
    this.input.consumeMenuAcceptUntilRelease();
    this.input.consumeMenuBackUntilRelease();
    this.invalidate();
    if (valid) request.confirm();
  }

  navigate(nav: FrameInput['nav']): void {
    this.validate();
    if (!this.open) return;
    const direction = nav.upHeld || nav.downHeld || nav.leftHeld || nav.rightHeld;
    if (!direction) this.directionsReleased = true;
    if (this.directionsReleased && direction && !this.directionHeld) {
      (nav.upHeld || nav.leftHeld ? this.keep : this.leave).focus();
    }
    this.directionHeld = direction;
    if (nav.back) this.cancel();
    else if (nav.accept) {
      if (document.activeElement === this.leave) this.confirm();
      else this.cancel();
    }
  }
}
