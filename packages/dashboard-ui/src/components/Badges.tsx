import { SimpleTooltip } from './Tooltip';

export function Badges({ badges }: { badges?: { text: string; color?: string; pulse?: boolean; tooltip?: string }[] }) {
    if (!badges || badges.length === 0) return null;
    return (
        <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap', marginTop: '4px', alignContent: 'flex-start' }}>
            {badges.map((b, i) => {
                const colorClass = b.color ? b.color : 'dim';
                return (
                    <SimpleTooltip key={i} content={b.tooltip}>
                        <span className={`badge ${colorClass}`}>
                            {b.pulse && <span className="pulse-dot"></span>}
                            {b.text}
                        </span>
                    </SimpleTooltip>
                );
            })}
        </div>
    );
}
