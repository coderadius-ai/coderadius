import type { TeaserSection } from '@coderadius/types';

export function Teaser({ section }: { section: TeaserSection }) {
    return (
        <div className="cr-teaser">
            <div className="cr-teaser__rule" aria-hidden="true" />

            <div className="cr-teaser__header">
                <h1 className="cr-teaser__title">{section.title}</h1>
                <p className="cr-teaser__tagline">{section.tagline}</p>
            </div>

            <p className="cr-teaser__body">{section.body}</p>

            {section.bullets && section.bullets.length > 0 && (
                <ul className="cr-teaser__bullets">
                    {section.bullets.map((bullet, i) => (
                        <li key={i} className="cr-teaser__bullet">
                            <span className="cr-teaser__bullet-dot" aria-hidden="true" />
                            {bullet}
                        </li>
                    ))}
                </ul>
            )}

            {section.footer && (
                <div className="cr-teaser__footer">
                    <p className="cr-teaser__footer-text">{section.footer}</p>
                </div>
            )}
        </div>
    );
}
