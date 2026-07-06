import type { RepoReadiness } from '../readiness.model';
import { ReadinessChecks } from './ReadinessChecks';
import { ActionCard } from './ActionCard';

export function RepoDetail({ repo }: { repo: RepoReadiness }) {
    return (
        <div className="cr-readiness__detail">
            <div className="cr-readiness__detail-inner">
                <div className="cr-readiness__detail-grid">
                    <ReadinessChecks checks={repo.checks} />
                    <ActionCard actions={repo.actions} />
                </div>
                <div className="cr-readiness__activity">
                    <span>Agent: <span className="tag">{repo.activity.agents.length > 0 ? repo.activity.agents.join(' + ') : 'none'}</span></span>
                    <span className="sep">&middot;</span>
                    <span>Rules: <span className="tag">{repo.ruleFiles.length > 0 ? repo.ruleFiles.join(', ') : 'none'}</span></span>
                    <span className="sep">&middot;</span>
                    <span>MCP: <span className={repo.mcpServers.length > 0 ? 'tag' : 'tag tag--off'}>{repo.mcpServers.length > 0 ? repo.mcpServers.join(', ') : 'none'}</span></span>
                </div>
            </div>
        </div>
    );
}
