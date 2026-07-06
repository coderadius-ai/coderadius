export const PHP_PROMPT_HINTS = `<php_rules>
HTTP CLIENTS (ExternalAPI, not Process):
curl_init/curl_exec, GuzzleHttp, Symfony HttpClient, file_get_contents(http) = ExternalAPI.

FILE-TRANSPORT SENDERS (ObjectStorage or ExternalAPI, not MessageChannel):
SftpSender, FtpClient, S3Uploader, GcsUploader, BlobClient = ObjectStorage or ExternalAPI. Never MessageChannel.

MONGODB (Database, not MessageChannel):
$client->selectCollection($db, 'name'), $db->getCollection('name') = Database. Even dynamic names (sprintf('quote_%s', $tipo)) = Database.

SQL WRITES (Database, not MessageChannel):
$db->preparedQuery('INSERT INTO foo'), $db->query('UPDATE foo') = Database. Table name = Database resource.

PROCESS SPAWNS:
exec(), shell_exec(), proc_open(), popen(), passthru(), system(), pcntl_fork() = Process infrastructure.

PLATFORM LOGGING (no infrastructure node):
error_log(), syslog(), openlog(), trigger_error() = platform logging, not infrastructure.

PHP SUPERGLOBALS: $_GET, $_POST, $_REQUEST, $_FILES, $_COOKIE, $_SESSION, $_SERVER, $_ENV = input/config, not infrastructure.

FRAMEWORK REQUEST READERS (NOT endpoints):
Symfony $request->get/query->get, Slim $request->getQueryParams/getParsedBody, Laravel $request->input/query = parameter accessors only, NOT route definitions. Do not emit APIEndpoint.

->get('key') ON NON-HTTP OBJECTS (NOT routes):
AMQPMessage->get('routing_key'), Doctrine $collection->get(), Laravel $collection->get(), DTO $order->get() = field accessors, NOT endpoints. Only emit APIEndpoint if the object is a registered HTTP request handler.

LEGACY PHP (PHP 4/5):
global $db, $GLOBALS['db'] = connection handles. mysql_query/mysqli_query/pg_query = Database. require_once = local dependency. file_get_contents('http://') = ExternalAPI.

WORDPRESS:
add_action('wp_ajax_*') = HTTP endpoint via admin-ajax.php. register_rest_route = inbound under /wp-json/. $wpdb->get_results('SELECT FROM wp_orders') = Database READ 'orders' (strip wp_ prefix). $wpdb->insert = Database WRITE.

PDO/DBAL: extract table from SQL literal in $pdo->prepare(), not the variable name.

SYMFONY DUAL DISPATCH:
$this->messageBus->dispatch($msg) (MessageBusInterface) = ASYNC broker, emit MessageChannel.
$this->eventDispatcher->dispatch($event) (EventDispatcherInterface) = IN-PROCESS sync event, NO MessageChannel.
Use constructor type hints to distinguish. Default to EventDispatcher for classes ending in Event.

SYMFONY MESSENGER HANDLERS:
__invoke(XxxMessage $message) or #[AsMessageHandler] = CONSUMES from the channel for that message type.
Channel name priority: (1) resolvedValue from resolved-invocation-arguments context, (2) log string literal, (3) snake_case from class name (lowest confidence).

CODEIGNITER 3:
$this->db->get('table') = READ, $this->db->insert('table') = WRITE, $this->db->query('SQL') = extract from SQL.

CAKEPHP 2/3:
$this->Order (loadModel) = table 'orders' (snake_case plural). TableRegistry::get('Orders') = 'orders'.

GRAPHQL BACKEND PHP:
Lighthouse #[Query]/#[Mutation]/#[Subscription] = INBOUND GRAPHQL endpoint, path="GRAPHQL OP methodName".
API Platform #[ApiResource(graphql:...)] = GRAPHQL QUERY/MUTATION per declared operation.
Webonyx FieldDefinition::create(['name'=>'user']) = GRAPHQL QUERY user.

GRAPHQL CLIENT PHP:
$client->post('/graphql', ['json'=>['query'=>..., 'operationName'=>'X']]) = OUTBOUND GRAPHQL.
Extract root field from query string. mutation keyword = GRAPHQL MUTATION.
</php_rules>`;
