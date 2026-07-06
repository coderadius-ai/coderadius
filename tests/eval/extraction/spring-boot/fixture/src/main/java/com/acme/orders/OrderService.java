package com.acme.orders;

import java.util.List;
import org.springframework.stereotype.Service;

/**
 * Plain Spring @Service (NOT a controller). Precision guard: its verb-like
 * method names (get / list / create) must NOT be mistaken for routes — only
 * @RestController / @Controller classes expose endpoints.
 */
@Service
public class OrderService {

    public Order get(String id) {
        return new Order(id);
    }

    public List<Order> list() {
        return List.of();
    }

    public Order create(Order order) {
        return order;
    }
}
