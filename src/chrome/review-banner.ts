// The line above the page: a notice with an optional button or link, and short confirmations that go away by themselves.
import { create } from "zustand";

export interface BannerAction {
  label: string;
  /** A button when given, else a link to `href`. */
  onClick?: () => void;
  href?: string;
}

interface BannerState {
  text: string;
  actions: BannerAction[];
}

export const useBanner = create<BannerState>()(() => ({ text: "", actions: [] }));

/** Show `text` (with its actions) in place of what was there; empty text takes it away. */
export function showBanner(text: string, actions: BannerAction[] = []): void {
  useBanner.setState({ text, actions: text ? actions : [] });
}

/** The banner's current text, for the code that must take back only its own message. */
export const bannerText = (): string => useBanner.getState().text;

/** A short confirmation that goes away by itself (unless something else has replaced it). */
export function flash(text: string): void {
  showBanner(text);
  setTimeout(() => {
    if (bannerText() === text) showBanner("");
  }, 4000);
}

export const reload = (): BannerAction => ({ label: "Reload", onClick: () => location.reload() });
