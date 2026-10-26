/**
 * @fileoverview The composer's state (D19, D39), the port of wilds.ai's staff reply composer: the
 * body under its bound (5,000 characters, D12), Write and Preview, the templates of the request's
 * category (a template under the general category, `other` unless the options name another, shows
 * under every category; the request's own come first), each appended to the body below a blank
 * line, and up to 3 pictures a message (D12). It holds no fetch: the page sends the body and the
 * picture ids through the product's route.
 */
import { useCallback, useMemo, useState } from 'react';

/** A reply template: its id, the label the menu shows, the category it belongs to (none or the general one for every category) and the words it appends. */
export interface OpsTemplate {
  readonly id: string;
  readonly label: string;
  readonly category?: string;
  readonly body: string;
}

export interface UseComposerOptions {
  /** The request's category, which picks the templates. */
  readonly category: string;
  readonly templates?: readonly OpsTemplate[];
  /** The body's bound in characters; D12's 5,000 by default. */
  readonly bodyMax?: number;
  /** The pictures a message takes; D12's 3 by default. */
  readonly picturesMax?: number;
  /** The category whose templates show under every category; `other` by default. */
  readonly generalCategory?: string;
}

export interface UseComposerResult {
  readonly body: string;
  setBody(body: string): void;
  readonly mode: 'write' | 'preview';
  setMode(mode: 'write' | 'preview'): void;
  /** The templates for the request's category, its own first, then the general ones. */
  readonly templates: readonly OpsTemplate[];
  /** Appends the template `id` to the body, below a blank line when the body holds words. */
  apply(id: string): void;
  readonly pictureIds: readonly string[];
  /** Adds a picture's id, up to the bound; a repeated id is added once. */
  addPicture(id: string): void;
  removePicture(id: string): void;
  /** Characters left under the bound; negative past it. */
  readonly charsLeft: number;
  /** Whether the body holds words within the bound. */
  readonly canSend: boolean;
  /** Empties the body and the pictures and returns to Write. */
  reset(): void;
}

/** D12's body bound. */
export const COMPOSER_BODY_MAX = 5_000;
/** D12's pictures a message. */
export const COMPOSER_PICTURES_MAX = 3;

/** The composer's state for a request of `options.category`. */
export function useComposer(options: UseComposerOptions): UseComposerResult {
  const { category, templates: given = [], bodyMax = COMPOSER_BODY_MAX, picturesMax = COMPOSER_PICTURES_MAX, generalCategory = 'other' } = options;
  const [body, setBody] = useState('');
  const [mode, setMode] = useState<'write' | 'preview'>('write');
  const [pictureIds, setPictureIds] = useState<readonly string[]>([]);

  const templates = useMemo(() => {
    const own = given.filter((template) => template.category === category);
    const general = given.filter((template) => template.category !== category && (template.category === undefined || template.category === generalCategory));
    return [...own, ...general];
  }, [given, category, generalCategory]);

  const apply = useCallback(
    (id: string) => {
      const template = given.find((candidate) => candidate.id === id);
      if (template === undefined) return;
      setBody((current) => (current.length > 0 ? `${current}\n\n${template.body}` : template.body));
    },
    [given],
  );

  const addPicture = useCallback(
    (id: string) => {
      setPictureIds((current) => (current.includes(id) || current.length >= picturesMax ? current : [...current, id]));
    },
    [picturesMax],
  );

  const removePicture = useCallback((id: string) => {
    setPictureIds((current) => current.filter((candidate) => candidate !== id));
  }, []);

  const reset = useCallback(() => {
    setBody('');
    setPictureIds([]);
    setMode('write');
  }, []);

  const charsLeft = bodyMax - body.length;
  return {
    body,
    setBody,
    mode,
    setMode,
    templates,
    apply,
    pictureIds,
    addPicture,
    removePicture,
    charsLeft,
    canSend: body.trim().length > 0 && charsLeft >= 0,
    reset,
  };
}
