import { useMemo, useRef, useEffect, type CSSProperties } from 'react';
import { ExternalLink, Link2 } from 'lucide-react';
import { TeamIcon } from '../../Taxonomy';
import { SimpleTooltip } from '../../Tooltip';
import type { SkillLibraryEntry } from '../skill-library.model';
import { toHttpUrl } from '../../../transformers/utils';

export function SkillDetail({ skill }: { skill: SkillLibraryEntry }) {
    const hasDuplicates = skill.duplicates.length > 0;
    const hasConsumers = skill.consumers.list.length > 0;
    const prov = skill.provenance;
    const repoUrls = useMemo(() => {
        const map = new Map<string, string>();
        for (const r of skill.repos) {
            if (r.url) map.set(r.name, toHttpUrl(r.url));
        }
        return map;
    }, [skill.repos]);
    if (!hasDuplicates && !hasConsumers && !prov) return null;

    const ref = useRef<HTMLDivElement>(null);
    useEffect(() => {
        const el = ref.current;
        if (!el) return;
        requestAnimationFrame(() => el.dataset.open = '');
        return () => { delete el.dataset.open; };
    }, []);

    return (
        <div className="cr-skill-lib__detail" ref={ref}>
            <div className="cr-skill-lib__detail-collapse">
                <div className="cr-skill-lib__detail-inner">
                    {prov && (
                        <div className="cr-skill-lib__provenance">
                            <span className="cr-skill-lib__provenance-label">Source</span>
                            {prov.url ? (
                                <a href={toHttpUrl(prov.url)} target="_blank" rel="noopener noreferrer" className="cr-ext-link">
                                    {prov.source}
                                    <ExternalLink size={9} className="cr-ext-link__icon" />
                                </a>
                            ) : (
                                <span className="cr-skill-lib__provenance-src">{prov.source}</span>
                            )}
                            {prov.type && <span className="meta">{prov.type}</span>}
                            {prov.updatedAt && <span className="meta">updated {prov.updatedAt.slice(0, 10)}</span>}
                        </div>
                    )}
                    <div className="cr-skill-lib__detail-grid">
                        {hasDuplicates && (
                            <div>
                                <div className="cr-skill-lib__detail-head">
                                    <span>Duplicates</span>
                                    <span className="meta">{skill.duplicates.length} across teams</span>
                                </div>
                                <div>
                                    {skill.duplicates.map((dup, i) => {
                                        const simPct = Math.round(dup.similarity * 100);
                                        const simTone = simPct >= 90 ? 'danger' : simPct >= 80 ? 'warn' : 'muted';
                                        return (
                                            <div key={i} className="cr-skill-lib__dup" style={{ '--row-i': i } as CSSProperties}>
                                                <SimpleTooltip content="Semantic similarity">
                                                    <span className={`cr-pill cr-pill--${simTone}`}>
                                                        {simPct}%
                                                    </span>
                                                </SimpleTooltip>
                                                <div>
                                                    <div className="cr-skill-lib__dup-name">
                                                        <span>{dup.name}</span>
                                                        <span className="cr-skill-lib__dup-team"><TeamIcon size={9} />{dup.team}</span>
                                                    </div>
                                                    {dup.filePath && (
                                                        <div className="cr-skill-lib__dup-path">
                                                            {dup.installedVia === 'symlink' && <Link2 size={10} className="cr-skill-lib__symlink-icon" />}
                                                            {dup.sourceUrl ? (
                                                                <a href={dup.sourceUrl} target="_blank" rel="noopener noreferrer" className="cr-ext-link">
                                                                    {dup.symlinkTarget ?? dup.filePath}
                                                                    <ExternalLink size={9} className="cr-ext-link__icon" />
                                                                </a>
                                                            ) : (
                                                                dup.symlinkTarget ?? dup.filePath
                                                            )}
                                                        </div>
                                                    )}
                                                </div>
                                            </div>
                                        );
                                    })}
                                </div>
                            </div>
                        )}
                        {hasConsumers && (
                            <div>
                                <div className="cr-skill-lib__detail-head">
                                    <span>Consumers</span>
                                    <span className="meta">{skill.consumers.list.length} services</span>
                                </div>
                                <div>
                                    {skill.consumers.list.map((c, i) => {
                                        const url = repoUrls.get(c.repo);
                                        return (
                                            <div key={i} className="cr-skill-lib__consumer-row" style={{ '--row-i': i } as CSSProperties}>
                                                {url ? (
                                                    <a href={url} target="_blank" rel="noopener noreferrer" className="cr-ext-link">
                                                        <span className="cr-skill-lib__consumer-repo">{c.service}</span>
                                                        <ExternalLink size={10} className="cr-ext-link__icon" />
                                                    </a>
                                                ) : (
                                                    <span className="cr-skill-lib__consumer-repo">{c.service}</span>
                                                )}
                                                <span className="cr-skill-lib__consumer-team"><TeamIcon size={9} />{c.team}</span>
                                            </div>
                                        );
                                    })}
                                </div>
                            </div>
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
}
