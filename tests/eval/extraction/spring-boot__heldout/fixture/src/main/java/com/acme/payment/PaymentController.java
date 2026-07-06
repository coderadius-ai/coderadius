package com.acme.payment;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;

/**
 * Spring controller WITHOUT a class-level @RequestMapping prefix: every route's
 * full path lives on the method-level mapping. Generalization case for the
 * empty-prefix composition path.
 */
@RestController
public class PaymentController {

    @PostMapping("/payments")
    public Payment pay(@RequestBody Payment payment) {
        return payment;
    }

    @GetMapping("/payments/{id}")
    public Payment get(@PathVariable String id) {
        return new Payment(id);
    }
}
