<?php

namespace App\Runner;

class ScriptRunner
{
    private string $scriptsDir;

    public function __construct(string $scriptsDir = '/opt/acme/scripts')
    {
        $this->scriptsDir = $scriptsDir;
    }

    /**
     * Spawns a background PHP script using exec with & for async execution.
     * The script name is determined by company and action parameters.
     */
    public function spawnCompanyScript(string $companyId, string $action, array $params = []): void
    {
        $scriptName = "process_{$companyId}_{$action}.php";
        $scriptPath = "{$this->scriptsDir}/{$scriptName}";
        $encodedParams = base64_encode(json_encode($params));

        exec("php {$scriptPath} {$encodedParams} > /dev/null 2>&1 &");
    }

    /**
     * Runs the batch notification processor as a background child process.
     * This script recursively calls spawnCompanyScript for each company.
     */
    public function runBatchProcessor(array $companies): void
    {
        foreach ($companies as $company) {
            $this->spawnCompanyScript($company['id'], 'batch_notify', [
                'type' => $company['notificationType'],
                'priority' => $company['priority'] ?? 'normal',
            ]);
        }
    }

    /**
     * Spawns a child process that itself spawns further sub-processes.
     * Demonstrates recursive exec spawning patterns.
     */
    public function spawnRecursiveWorker(string $jobId, int $depth = 0): void
    {
        if ($depth > 3) {
            return;
        }

        $workerScript = "{$this->scriptsDir}/recursive_worker.php";
        $nextDepth = $depth + 1;
        exec("php {$workerScript} --job={$jobId} --depth={$nextDepth} > /dev/null 2>&1 &");
    }

    /**
     * Executes a data export script synchronously and returns the output.
     */
    public function runExportScript(string $exportType, string $dateRange): string
    {
        $scriptPath = "{$this->scriptsDir}/export_{$exportType}.php";
        $output = [];
        $exitCode = 0;
        exec("php {$scriptPath} --range={$dateRange}", $output, $exitCode);

        if ($exitCode !== 0) {
            throw new \RuntimeException("Export script failed with code {$exitCode}");
        }
        return implode("\n", $output);
    }
}
