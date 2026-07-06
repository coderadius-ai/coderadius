/**
 * A/B diagnostic: batch structured-output integrity across @mastra/core versions.
 *
 * Runs N live batch calls against the fast PHP io-confirmed analyzer agent with
 * an anonymized (acme) mixed-batch prompt that mirrors the production shape
 * (per-function entity-table block + DI context + serviceId resolved-invocation
 * hints). Per run it reports:
 *   - infra entries present in response.text (what the model emitted)
 *   - entries missing the required `type` field (zod drops them silently)
 *   - infra entries surviving in response.object (what the pipeline keeps)
 *
 * Usage: DIAG_N=10 bun scripts/diag-mastra-batch-ab.ts
 */
import { getAnalyzerStrategy, BatchedFastAnalysisSchema } from '../src/ai/agents/unified-analyzer.js';

const N = Number(process.env.DIAG_N ?? 10);

// One neutral table name per run → quasi-independent samples at temperature 0.
const TABLES = [
    'app_account', 'shop_customer', 'site_member', 'core_user', 'auth_account',
    'store_client', 'portal_user', 'crm_contact', 'base_account', 'web_member',
];

function buildPrompt(table: string): string {
    return `Analyze EACH function below independently. Return one "analyses" array entry per function, with "function_key" set to the function's NUMBER as shown in its section header. Each entry's infrastructure and api_calls MUST derive ONLY from that function's own source block. Never copy an entry from one function to another.

Language: php
===== FUNCTION 1 of 2 — function_key: "1" =====
Function name: Acme\\Shop\\LoginBundle\\Command\\ResetExpiredCredentialCommand.execute
File path: src/Acme/Shop/LoginBundle/Command/ResetExpiredCredentialCommand.php

--- Resolved Entity Table Names (ground truth from ORM annotations) ---
The following entity classes are imported and have KNOWN table mappings.
You MUST use these table names — do NOT infer from class name.

  Account → table "${table}"

When you see a Repository, Service, or Handler that uses createQueryBuilder(),
EntityManager, or similar ORM queries on these entities, use the table name shown here.
--- End Entity Table Names ------ File Constants (resolved from AST/import graph) ---
ResetExpiredCredentialCommand.OPT_DRY_RUN = "dry-run"
self::OPT_DRY_RUN = "dry-run"
ResetExpiredCredentialCommand.CREDENTIAL_DEADLINE = 90
self::CREDENTIAL_DEADLINE = 90
--- End File Constants ---

--- DI Context (use this to resolve infrastructure names) ---
File imports:
use Acme\\Shop\\CalendarBundle\\Date\\Day;
use Acme\\Shop\\CoreBundle\\Entity\\Account\\Account;
use Acme\\Shop\\CoreBundle\\Entity\\Account\\AccountRepository;
use Acme\\Shop\\CoreBundle\\Security\\AccountSecurityPolicy;
use Acme\\Shop\\LoginBundle\\Service\\ResetCredential;
use Symfony\\Component\\Console\\Attribute\\AsCommand;
use Symfony\\Component\\Console\\Command\\Command;
use Symfony\\Component\\Console\\Input\\InputInterface;
use Symfony\\Component\\Console\\Input\\InputOption;
use Symfony\\Component\\Console\\Output\\OutputInterface;

Class constructor (for DI resolution):
\`\`\`
public function __construct(
        private readonly AccountRepository $accountRepository,
        private readonly ResetCredential $resetCredential,
    ) {
        parent::__construct();
    }
\`\`\`

Class property types:
this->accountRepository: AccountRepository
this->resetCredential: ResetCredential
--- End DI Context ---

--- Taint Context (auto-generated from import graph) ---
Tainted symbols (trace back to I/O sinks): Account, ResetExpiredCredentialCommand, ResetExpiredCredentialCommand.OPT_DRY_RUN, ResetExpiredCredentialCommand.CREDENTIAL_DEADLINE, AccountRepository, ResetCredential, AccountSecurityPolicy
DI aliases: this->accountRepository → AccountRepository (tainted), this->resetCredential → ResetCredential (tainted)
--- End Taint Context ------ Resolved Critical I/O Arguments (static value resolution) ---
$this->accountRepository->getAccountsWithExpiringCredentialsIterator("Acme\\\\Shop\\\\CoreBundle\\\\Entity\\\\Account\\\\AccountRepository")
  resource: serviceId → MessageChannel READS
  resolvedValue: "Acme\\\\Shop\\\\CoreBundle\\\\Entity\\\\Account\\\\AccountRepository"
  confidence: 0.78 (complete)
  trace: "Acme\\\\Shop\\\\CoreBundle\\\\Entity\\\\Account\\\\AccountRepository" -> "Acme\\\\Shop\\\\CoreBundle\\\\Entity\\\\Account\\\\AccountRepository"
$this->resetCredential->resetCredentialWithAccount("Acme\\\\Shop\\\\LoginBundle\\\\Service\\\\ResetCredential")
  resource: serviceId → MessageChannel READS
  resolvedValue: "Acme\\\\Shop\\\\LoginBundle\\\\Service\\\\ResetCredential"
  confidence: 0.78 (complete)
  trace: "Acme\\\\Shop\\\\LoginBundle\\\\Service\\\\ResetCredential" -> "Acme\\\\Shop\\\\LoginBundle\\\\Service\\\\ResetCredential"
--- End Resolved Critical I/O Arguments ---
\`\`\`
protected function execute(InputInterface $input, OutputInterface $output): int
    {
        $dryRun = (bool) $input->getOption(self::OPT_DRY_RUN);
        if ($dryRun) {
            $output->writeln('<info>Dry-run mode enabled</info>');
        }

        $day = (new \\DateTime())->sub(new \\DateInterval(sprintf('P%sD', self::CREDENTIAL_DEADLINE)));
        $dateFrom = Day::beginOf($day);
        $dateTo = Day::endOf($day);
        $output->writeln(sprintf('<info>Taking accounts with last credential update from %s to %s</info>', $dateFrom->format('c'), $dateTo->format('c')));

        $accountIterator = $this->accountRepository->getAccountsWithExpiringCredentialsIterator(
            $dateFrom,
            $dateTo,
        );

        foreach ($accountIterator as $row) {
            /** @var Account $account */
            $account = $row[0];

            if (AccountSecurityPolicy::canSkipAutomaticCredentialReset($account)) {
                $output->writeln(
                    sprintf(
                        'Account <%d> (%s) is skipped for policy',
                        $account->getId(),
                        $account->getUsername()
                    )
                );
                continue;
            }

            if (! $dryRun) {
                try {
                    $this->resetCredential->resetCredentialWithAccount($account, false);
                } catch (\\Exception $e) {
                    $output->writeln(
                        sprintf(
                            'Error reset credential for account <%d> (%s): %s',
                            $account->getId(),
                            $account->getUsername(),
                            $e->getMessage()
                        )
                    );
                }
            }

            $output->writeln(sprintf('Credential reset for account <%d> (%s)', $account->getId(), $account->getUsername()));

            unset($account);
        }

        return 0;
    }
\`\`\`
===== FUNCTION 2 of 2 — function_key: "2" =====
Function name: Acme\\Shop\\LoginBundle\\Command\\CredentialReminderCommand.execute
File path: src/Acme/Shop/LoginBundle/Command/CredentialReminderCommand.php

--- Resolved Entity Table Names (ground truth from ORM annotations) ---
The following entity classes are imported and have KNOWN table mappings.
You MUST use these table names — do NOT infer from class name.

  Account → table "${table}"

When you see a Repository, Service, or Handler that uses createQueryBuilder(),
EntityManager, or similar ORM queries on these entities, use the table name shown here.
--- End Entity Table Names ------ File Constants (resolved from AST/import graph) ---
CredentialReminderCommand.OPT_DRY_RUN = "dry-run"
self::OPT_DRY_RUN = "dry-run"
--- End File Constants ---

--- DI Context (use this to resolve infrastructure names) ---
File imports:
use Acme\\Shop\\CalendarBundle\\Date\\Day;
use Acme\\Shop\\CoreBundle\\Entity\\Account\\Account;
use Acme\\Shop\\CoreBundle\\Entity\\Account\\AccountRepository;
use Acme\\Shop\\CoreBundle\\Security\\AccountSecurityPolicy;
use Acme\\Shop\\LoginBundle\\Mailer\\CredentialReminderMailer;
use Symfony\\Component\\Console\\Attribute\\AsCommand;
use Symfony\\Component\\Console\\Command\\Command;
use Symfony\\Component\\Console\\Input\\InputArgument;
use Symfony\\Component\\Console\\Input\\InputInterface;
use Symfony\\Component\\Console\\Input\\InputOption;
use Symfony\\Component\\Console\\Output\\OutputInterface;

Class constructor (for DI resolution):
\`\`\`
public function __construct(
        private readonly AccountRepository $accountRepository,
        private readonly CredentialReminderMailer $mailer,
    ) {
        parent::__construct();
    }
\`\`\`

Class property types:
this->accountRepository: AccountRepository
this->mailer: CredentialReminderMailer
--- End DI Context ---

--- Taint Context (auto-generated from import graph) ---
Tainted symbols (trace back to I/O sinks): Account, CredentialReminderCommand, CredentialReminderCommand.OPT_DRY_RUN, CredentialReminderCommand.ARG_days, AccountRepository, AccountSecurityPolicy, CredentialReminderMailer
DI aliases: this->accountRepository → AccountRepository (tainted), this->mailer → CredentialReminderMailer (tainted)
--- End Taint Context ------ Resolved Critical I/O Arguments (static value resolution) ---
$this->accountRepository->getAccountsWithExpiringCredentialsIterator("Acme\\\\Shop\\\\CoreBundle\\\\Entity\\\\Account\\\\AccountRepository")
  resource: serviceId → MessageChannel READS
  resolvedValue: "Acme\\\\Shop\\\\CoreBundle\\\\Entity\\\\Account\\\\AccountRepository"
  confidence: 0.78 (complete)
  trace: "Acme\\\\Shop\\\\CoreBundle\\\\Entity\\\\Account\\\\AccountRepository" -> "Acme\\\\Shop\\\\CoreBundle\\\\Entity\\\\Account\\\\AccountRepository"
$this->mailer->sendCredentialReminder("Acme\\\\Shop\\\\LoginBundle\\\\Mailer\\\\CredentialReminderMailer")
  resource: serviceId → MessageChannel READS
  resolvedValue: "Acme\\\\Shop\\\\LoginBundle\\\\Mailer\\\\CredentialReminderMailer"
  confidence: 0.78 (complete)
  trace: "Acme\\\\Shop\\\\LoginBundle\\\\Mailer\\\\CredentialReminderMailer" -> "Acme\\\\Shop\\\\LoginBundle\\\\Mailer\\\\CredentialReminderMailer"
--- End Resolved Critical I/O Arguments ---
\`\`\`
protected function execute(InputInterface $input, OutputInterface $output): int
    {
        $dryRun = $input->getOption(self::OPT_DRY_RUN);
        if (true === $dryRun) {
            $output->writeln('<info>Dry-run mode enabled</info>');
        }

        $daysBefore = $this->getDaysBefore($input);
        $interval = new \\DateInterval(
            sprintf('P%dD', ResetExpiredCredentialCommand::CREDENTIAL_DEADLINE - $daysBefore)
        );
        $day = (new \\DateTime())->sub($interval);

        $dateFrom = Day::beginOf($day);
        $dateTo = Day::endOf($day);
        $output->writeln(sprintf('<info>Taking accounts with last credential update from %s to %s</info>', $dateFrom->format('c'), $dateTo->format('c')));

        $accountIterator = $this->accountRepository->getAccountsWithExpiringCredentialsIterator($dateFrom, $dateTo);

        foreach ($accountIterator as $row) {
            /** @var Account $account */
            $account = $row[0];

            if (AccountSecurityPolicy::canSkipAutomaticCredentialReset($account)) {
                $output->writeln(
                    sprintf(
                        'Account <%d> (%s) is skipped for policy',
                        $account->getId(),
                        $account->getUsername()
                    )
                );
                continue;
            }

            if (AccountSecurityPolicy::canSkipAutomaticCredentialResetReminder($account)) {
                $output->writeln(
                    sprintf(
                        'Account <%d> (%s) is skipped because deactivation is pending',
                        $account->getId(),
                        $account->getUsername()
                    )
                );
                continue;
            }

            if (false === $dryRun) {
                try {
                    $this->mailer->sendCredentialReminder($account, $daysBefore);
                } catch (\\Exception $e) {
                    $output->writeln(sprintf('Error sending email for account <%d> (%s)', $account->getId(), $account->getUsername()));
                }
            }

            $output->writeln(sprintf('Reminder sent for account <%d> (%s)', $account->getId(), $account->getUsername()));

            unset($account);
        }

        return 0;
    }
\`\`\``;
}

function stripFences(t: string): string {
    return t.trim().replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
}

const agent = await getAnalyzerStrategy('semantic', 'php', true);
console.log(`agent: ${agent.id}`);

let totText = 0, totMissingType = 0, totObj = 0, runs = 0, failures = 0;
for (let i = 0; i < N; i++) {
    const prompt = buildPrompt(TABLES[i % TABLES.length]);
    let res;
    try {
        res = await agent.generate(prompt, {
            structuredOutput: {
                schema: BatchedFastAnalysisSchema,
                ...(process.env.DIAG_INJECT ? { jsonPromptInjection: true } : {}),
            },
            modelSettings: { maxRetries: 0, temperature: 0 },
            abortSignal: AbortSignal.timeout(90_000),
        });
    } catch (err) {
        failures++;
        console.log(`run ${i + 1}: CALL FAILED — ${(err as Error).message?.slice(0, 120)}`);
        await new Promise(r => setTimeout(r, 2000));
        continue;
    }
    runs++;

    let textEntries = 0, missingType = 0;
    let textParsed = true;
    try {
        const t = JSON.parse(stripFences(res.text ?? ''));
        for (const a of t.analyses ?? []) {
            for (const e of a.infrastructure ?? []) {
                textEntries++;
                if (!('type' in e)) missingType++;
            }
        }
    } catch {
        textParsed = false;
    }

    let objEntries = 0;
    for (const a of (res.object as any)?.analyses ?? []) {
        objEntries += (a.infrastructure ?? []).length;
    }

    totText += textEntries; totMissingType += missingType; totObj += objEntries;
    console.log(`run ${i + 1} [${TABLES[i % TABLES.length]}]: text entries=${textParsed ? textEntries : 'UNPARSEABLE'} missingType=${missingType} object entries=${objEntries}`);
    if (i === 0) {
        const firstInfra = (() => {
            try {
                const t = JSON.parse(stripFences(res.text ?? ''));
                return JSON.stringify(t.analyses?.[0]?.infrastructure ?? []);
            } catch { return '(text unparseable)'; }
        })();
        console.log(`  sample text infra[fn1]: ${firstInfra.slice(0, 300)}`);
    }
    await new Promise(r => setTimeout(r, 500));
}

console.log(`\nTOTAL over ${runs} ok runs (${failures} failed): text entries=${totText}, missing type=${totMissingType}, object entries=${totObj}, silently dropped=${totText - totObj}`);
