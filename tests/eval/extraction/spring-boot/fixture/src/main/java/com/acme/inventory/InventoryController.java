package com.acme.inventory;

import java.util.List;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestMethod;
import org.springframework.web.bind.annotation.RestController;

/**
 * Spring controller that uses the generic @RequestMapping(method = ...) form
 * for one action alongside the @GetMapping shorthand.
 */
@RestController
@RequestMapping("/inventory")
public class InventoryController {

    @GetMapping
    public List<Item> list() {
        return List.of();
    }

    @GetMapping("/{sku}")
    public Item bySku(@PathVariable String sku) {
        return new Item(sku);
    }

    @RequestMapping(value = "/reserve", method = RequestMethod.POST)
    public Item reserve(@PathVariable String sku) {
        return new Item(sku);
    }
}
