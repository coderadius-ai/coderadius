import { useState, useEffect, useRef } from 'react';
import type { TabsSection } from '@coderadius/types';
import { SectionRenderer } from './SectionRenderer';

export function Tabs({ section, idx }: { section: TabsSection; idx: number | string }) {
    const [activeTabId, setActiveTabId] = useState(section.tabs[0]?.id);
    const [isStuck, setIsStuck] = useState(false);
    const sentinelRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const observer = new IntersectionObserver(
            ([entry]) => {
                setIsStuck(!entry.isIntersecting);
            },
            { threshold: [0] }
        );

        if (sentinelRef.current) {
            observer.observe(sentinelRef.current);
        }

        return () => observer.disconnect();
    }, []);

    return (
        <div className="tabs-container" id={`tabs-${idx}`}>
            <div ref={sentinelRef} style={{ height: '1px', marginBottom: '-1px', pointerEvents: 'none' }} />
            <div className={`tabs-nav ${isStuck ? 'is-stuck' : ''}`}>
                {section.tabs.map((tab) => (
                    <button
                        key={tab.id}
                        className={`tab-btn ${activeTabId === tab.id ? 'active' : ''}`}
                        onClick={() => setActiveTabId(tab.id)}
                    >
                        {tab.label}
                    </button>
                ))}
            </div>
            {section.tabs.map((tab, tIdx) => (
                <div
                    key={tab.id}
                    className={`tab-pane ${activeTabId === tab.id ? 'active' : ''}`}
                >
                    {activeTabId === tab.id && tab.sections.map((subSec, subIdx) => {
                        const sectionToRender = { ...subSec };
                        // Remove title if it matches the tab label to avoid redundancy
                        if ('title' in sectionToRender && sectionToRender.title === tab.label) {
                            sectionToRender.title = '';
                        }
                        return <SectionRenderer key={subIdx} section={sectionToRender as any} idx={`${idx}-${tIdx}-${subIdx}`} />;
                    })}
                </div>
            ))}
        </div>
    );
}
