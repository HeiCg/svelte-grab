/**
 * Annotation mode (docs/agent-runtime-spec.md, Phase 6): the human collects
 * several annotations (one element or a set + a comment each) and sends them
 * as one task. This module is the pure part: the pending-annotation store and
 * the agent text. DOM work (refs, stable keys, sources) lives in
 * `runtime/annotations.ts`.
 */

/** Pending annotations kept at once (bounds memory and the `/context` payload). */
export const MAX_ANNOTATIONS = 50;
/** Elements kept per annotation. */
export const MAX_REFS_PER_ANNOTATION = 50;
/** Characters kept per comment. */
export const MAX_COMMENT_LENGTH = 2000;
/** Characters kept in the global instruction. */
export const MAX_INSTRUCTION_LENGTH = 4000;

/** One annotated element, as the agent sees it (same fields as `ui_find`). */
export interface AnnotationRef {
	/** Session ref `eN`, stamped as `data-sg-ref`. */
	ref: string;
	/** `ui://` stable key: survives re-renders and HMR. */
	stableKey: string;
	component: string | null;
	/** `file:line`, or `null` without source info. */
	source: string | null;
	/** The element is gone and its stable key matches nothing on the page now. */
	stale?: true;
}

export interface Annotation {
	/** `#N`: counts up while annotations are pending, restarts at 1 once none are left. */
	id: number;
	comment: string;
	refs: AnnotationRef[];
	/** Epoch ms. */
	createdAt: number;
}

export interface NewAnnotation<T> {
	comment: string;
	refs: AnnotationRef[];
	/** Live elements behind `refs` (same order), for badges and rebinding. */
	targets?: T[];
}

interface Entry<T> {
	annotation: Annotation;
	targets: T[];
}

function copyAnnotation(a: Annotation): Annotation {
	return { ...a, refs: a.refs.map((r) => ({ ...r })) };
}

/**
 * Pending annotations of one page. `T` is the element type (kept out of
 * `list()`, which is what gets serialized).
 */
export class AnnotationStore<T = unknown> {
	private entries: Entry<T>[] = [];
	private counter = 0;
	private instructionText = '';
	private listeners = new Set<() => void>();

	get size(): number {
		return this.entries.length;
	}

	get isFull(): boolean {
		return this.entries.length >= MAX_ANNOTATIONS;
	}

	/** Id the next `add()` will get. */
	get nextId(): number {
		return this.entries.length === 0 ? 1 : this.counter + 1;
	}

	get instruction(): string {
		return this.instructionText;
	}

	/**
	 * Store an annotation. Returns `null` (and stores nothing) without refs or
	 * when `MAX_ANNOTATIONS` are already pending.
	 */
	add(input: NewAnnotation<T>, now: number = Date.now()): Annotation | null {
		if (input.refs.length === 0 || this.isFull) return null;
		if (this.entries.length === 0) this.counter = 0;
		const annotation: Annotation = {
			id: ++this.counter,
			comment: normalizeComment(input.comment),
			refs: input.refs.slice(0, MAX_REFS_PER_ANNOTATION).map((r) => ({ ...r })),
			createdAt: now
		};
		const targets = (input.targets ?? []).slice(0, MAX_REFS_PER_ANNOTATION);
		this.entries.push({ annotation, targets });
		this.emit();
		return copyAnnotation(annotation);
	}

	update(id: number, comment: string): boolean {
		const entry = this.find(id);
		if (!entry) return false;
		entry.annotation.comment = normalizeComment(comment);
		this.emit();
		return true;
	}

	remove(id: number): boolean {
		const i = this.entries.findIndex((e) => e.annotation.id === id);
		if (i < 0) return false;
		this.entries.splice(i, 1);
		this.emit();
		return true;
	}

	/** Swap the refs (and live elements) of an annotation, e.g. after rebinding. */
	replaceRefs(id: number, refs: AnnotationRef[], targets?: T[]): boolean {
		const entry = this.find(id);
		if (!entry) return false;
		entry.annotation.refs = refs.map((r) => ({ ...r }));
		if (targets) entry.targets = [...targets];
		this.emit();
		return true;
	}

	setInstruction(text: string): void {
		this.instructionText = String(text ?? '').trim().slice(0, MAX_INSTRUCTION_LENGTH);
		this.emit();
	}

	/** Drop every annotation and the instruction; numbering restarts at #1. */
	clear(): void {
		this.entries = [];
		this.counter = 0;
		this.instructionText = '';
		this.emit();
	}

	/** Copies of the pending annotations, oldest first. */
	list(): Annotation[] {
		return this.entries.map((e) => copyAnnotation(e.annotation));
	}

	targetsOf(id: number): T[] {
		return [...(this.find(id)?.targets ?? [])];
	}

	/** Called after every change. Returns the unsubscribe function. */
	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	private find(id: number): Entry<T> | undefined {
		return this.entries.find((e) => e.annotation.id === id);
	}

	private emit(): void {
		for (const listener of this.listeners) {
			try {
				listener();
			} catch {
				// A broken listener must not break the store.
			}
		}
	}
}

function normalizeComment(comment: string): string {
	return String(comment ?? '').trim().slice(0, MAX_COMMENT_LENGTH);
}

const LOCATOR_HINT =
	'Refs are stamped as data-sg-ref: locate with [data-sg-ref="<ref>"], or pass the ref or ui:// key to ui_inspect.';

/**
 * Agent text for a batch of annotations: one block per annotation with its
 * comment and, per element, ref + component + source + stable key.
 */
export function formatAnnotationsForAgent(
	annotations: Annotation[],
	instruction: string,
	shorten: (path: string) => string = (p) => p
): string {
	if (annotations.length === 0) return 'No pending annotations.';

	const lines = [`UI annotations: ${annotations.length}`];
	if (instruction.trim()) lines.push(`Instruction: ${instruction.trim()}`);
	lines.push('');

	for (const a of annotations) {
		const count = `${a.refs.length} element${a.refs.length === 1 ? '' : 's'}`;
		const comment = a.comment ? a.comment.replace(/\r?\n/g, '\n    ') : '(no comment)';
		lines.push(`#${a.id} (${count}): ${comment}`);
		for (const r of a.refs) {
			const component = r.component ? `<${r.component}>` : '(no component)';
			const source = r.source ? shortenSource(r.source, shorten) : '(no source)';
			lines.push(`  - ${r.ref} ${component} ${source}${r.stale ? ' (element gone)' : ''}`);
			lines.push(`    key: ${r.stableKey}`);
		}
	}

	lines.push('', LOCATOR_HINT);
	return lines.join('\n');
}

/** Shorten the file part of `file:line`. */
function shortenSource(source: string, shorten: (path: string) => string): string {
	const m = source.match(/^(.*):(\d+)$/);
	return m ? `${shorten(m[1])}:${m[2]}` : shorten(source);
}
