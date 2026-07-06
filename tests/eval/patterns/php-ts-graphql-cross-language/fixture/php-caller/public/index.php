<?php
// Symfony Runtime entrypoint.
require_once __DIR__ . '/../vendor/autoload_runtime.php';

return function (array $context) {
    return new Acme\Orders\Kernel($context['APP_ENV'], (bool) $context['APP_DEBUG']);
};
