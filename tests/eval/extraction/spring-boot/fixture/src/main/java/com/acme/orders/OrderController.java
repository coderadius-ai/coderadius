package com.acme.orders;

import java.util.List;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * Idiomatic Spring MVC controller. Class-level @RequestMapping("/orders")
 * composes with the method-level @<Verb>Mapping paths. Bodies are sink-free
 * (no DB / HTTP / queue I/O) so the only architectural signal is the route.
 */
@RestController
@RequestMapping("/orders")
public class OrderController {

    @GetMapping
    public List<Order> list() {
        return List.of();
    }

    @GetMapping("/{id}")
    public Order get(@PathVariable String id) {
        return new Order(id);
    }

    @PostMapping
    public Order create(@RequestBody Order order) {
        return order;
    }

    @PutMapping("/{id}")
    public Order update(@PathVariable String id, @RequestBody Order order) {
        return order;
    }

    @DeleteMapping("/{id}")
    public void cancel(@PathVariable String id) {
        // no-op
    }
}
