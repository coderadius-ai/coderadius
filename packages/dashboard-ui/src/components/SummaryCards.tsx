import type { SummaryCardsSection } from '@coderadius/types';

export function SummaryCards({ section }: { section: SummaryCardsSection }) {
    return (
        <section className="stagger-1">
            <div className="summary-grid">
                {section.cards.map((c, i) => (
                    <div 
                        key={i} 
                        className="summary-card spotlight-card" 
                        style={{ animationDelay: `${i * 50}ms` }}
                    >
                        <div className={`summary-value ${c.color ? 'color-text-' + c.color : 'color-text-teal'}`}>
                            {c.value}
                        </div>
                        <div className="summary-label">{c.label}</div>
                    </div>
                ))}
            </div>
        </section>
    );
}
