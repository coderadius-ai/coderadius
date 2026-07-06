<?php

namespace TravelApp\LegacyCore;

class MagicDbEntity
{
    protected $tableName;
    protected $data = [];

    public function __construct($tableName)
    {
        $this->tableName = $tableName;
    }

    // The AST has no idea what the class properties are!
    public function __set($name, $value)
    {
        $this->data[$name] = $value;
    }

    public function __get($name)
    {
        return $this->data[$name] ?? null;
    }

    // Columns and values are derived at runtime from the array keys
    public function save(\mysqli $db)
    {
        $columns = implode(', ', array_keys($this->data));
        
        $values = array_map(function($val) use ($db) {
            return is_numeric($val) ? $val : "'" . $db->real_escape_string($val) . "'";
        }, array_values($this->data));
        
        $valsString = implode(', ', $values);

        $sql = "INSERT INTO {$this->tableName} ($columns) VALUES ($valsString) 
                ON DUPLICATE KEY UPDATE ";
        
        $updates = [];
        foreach ($this->data as $col => $val) {
            $safeVal = is_numeric($val) ? $val : "'" . $db->real_escape_string($val) . "'";
            $updates[] = "$col = $safeVal";
        }
        $sql .= implode(', ', $updates);

        return $db->query($sql);
    }
}
