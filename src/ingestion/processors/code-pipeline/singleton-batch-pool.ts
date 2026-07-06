/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * SingletonBatchPool — cross-call micro-batching
 *
 * The orchestrator processes files concurrently but invokes extractSemantics
 * once per file (write-through), so cross-FILE singleton functions never meet
 * inside one call — each used to pay the full fixed prompt prefix
 * (system prompt + schema, ~4K tokens) alone. This pool collects singletons
 * ACROSS concurrent calls and flushes a group when it reaches `maxBatch` or
 * `flushDelayMs` after its first member, whichever comes first.
 *
 * Fully generic: grouping and execution are injected, so the pool knows
 * nothing about LLMs and is owned per-repo by the orchestrator (repo-scoped
 * dependencies like the symbol registry stay correct by construction).
 * Every submitted promise is awaited by its submitting call, so the pool is
 * always empty when the owning repo's file loop completes — no drain needed.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

interface PendingMember<TTask, TOutcome> {
    task: TTask;
    resolve: (outcome: TOutcome) => void;
    reject: (err: unknown) => void;
}

interface PoolGroup<TTask, TOutcome> {
    members: Array<PendingMember<TTask, TOutcome>>;
    timer: ReturnType<typeof setTimeout>;
}

export class SingletonBatchPool<TTask, TOutcome> {
    private readonly groups = new Map<string, PoolGroup<TTask, TOutcome>>();

    constructor(
        private readonly keyOf: (task: TTask) => string,
        private readonly executeBatch: (tasks: TTask[]) => Promise<TOutcome[]>,
        private readonly executeSingle: (task: TTask) => Promise<TOutcome>,
        private readonly maxBatch: number,
        private readonly flushDelayMs: number,
    ) {}

    /** Enqueue a task; resolves with its outcome when its group flushes. */
    submit(task: TTask): Promise<TOutcome> {
        return new Promise<TOutcome>((resolve, reject) => {
            const key = this.keyOf(task);
            const group = this.groups.get(key) ?? this.openGroup(key);
            group.members.push({ task, resolve, reject });
            if (group.members.length >= this.maxBatch) this.flush(key);
        });
    }

    private openGroup(key: string): PoolGroup<TTask, TOutcome> {
        const group: PoolGroup<TTask, TOutcome> = {
            members: [],
            timer: setTimeout(() => this.flush(key), this.flushDelayMs),
        };
        this.groups.set(key, group);
        return group;
    }

    private flush(key: string): void {
        const group = this.groups.get(key);
        if (!group) return;
        this.groups.delete(key);
        clearTimeout(group.timer);
        void this.execute(group.members);
    }

    private async execute(members: Array<PendingMember<TTask, TOutcome>>): Promise<void> {
        try {
            if (members.length === 1) {
                members[0].resolve(await this.executeSingle(members[0].task));
                return;
            }
            const outcomes = await this.executeBatch(members.map(m => m.task));
            members.forEach((member, i) => member.resolve(outcomes[i]));
        } catch (err) {
            for (const member of members) member.reject(err);
        }
    }
}
