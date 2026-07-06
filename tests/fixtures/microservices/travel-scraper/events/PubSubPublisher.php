<?php

namespace TravelApp\Events;

// Simulated external classes
class PubSubClient {
    public function topic($topicName) { return new Topic($topicName); }
}

class Topic {
    public function __construct($name) {}
    public function info() { return ['schemaSettings' => ['encoding' => 'JSON']]; }
    public function publish($data) { /* logica fittizia di pubblicazione */ }
}

class Message {
    public function serializeToJsonString() { return json_encode($this); }
}

class LoggerInterface {
    public function error($msg) {}
}

class PubSubPublisher
{
    private PubSubClient $pubSubClient;
    private string $topic;
    private LoggerInterface $logger;

    public function __construct(PubSubClient $pubSubClient, string $topic, LoggerInterface $logger)
    {
        $this->pubSubClient = $pubSubClient;
        $this->topic = $topic;
        $this->logger = $logger;
    }

    public function publish(Message $message): void
    {
        $topic = $this->pubSubClient->topic($this->topic);

        // get the encoding type.
        $topicInfo = $topic->info();
        $encoding = '';
        if (isset($topicInfo['schemaSettings']['encoding'])) {
            $encoding = $topicInfo['schemaSettings']['encoding'];
        }

        // if encoding is not set, we can't continue.
        if ($encoding === '') {
            $this->logger->error('Topic ' . $this->topic . ' does not have schema enabled');
            return;
        }

        $encodedMessageData = '';
        if ($encoding === 'BINARY') {
            // encode as protobuf binary.
            // $encodedMessageData = $message->serializeToString();
        } else {
            // encode as JSON.
            $encodedMessageData = $message->serializeToJsonString();
        }

        $topic->publish(['data' => $encodedMessageData]);
    }
}
