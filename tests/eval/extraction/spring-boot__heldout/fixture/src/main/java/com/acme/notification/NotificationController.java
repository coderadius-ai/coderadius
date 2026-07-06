package com.acme.notification;

import java.util.List;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * Spring controller exercising @PatchMapping (a verb absent from the training
 * fixture) and a class-prefix composition with @PostMapping("/broadcast").
 */
@RestController
@RequestMapping("/notifications")
public class NotificationController {

    @GetMapping
    public List<Notification> list() {
        return List.of();
    }

    @PatchMapping("/{id}")
    public Notification acknowledge(@PathVariable String id) {
        return new Notification(id);
    }

    @PostMapping("/broadcast")
    public Notification broadcast(@RequestBody Notification notification) {
        return notification;
    }
}
