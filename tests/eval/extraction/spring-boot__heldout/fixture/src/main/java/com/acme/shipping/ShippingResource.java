package com.acme.shipping;

import java.util.List;
import jakarta.ws.rs.DELETE;
import jakarta.ws.rs.GET;
import jakarta.ws.rs.POST;
import jakarta.ws.rs.Path;
import jakarta.ws.rs.PathParam;
import jakarta.ws.rs.Produces;
import jakarta.ws.rs.core.MediaType;

/**
 * JAX-RS (Jakarta REST) resource. Class-level @Path("/shipping") composes with
 * method-level @Path sub-paths; the HTTP verb is the marker annotation
 * (@GET / @POST / @DELETE). Generalization case: a different routing dialect
 * from the Spring annotations in the training fixture.
 */
@Path("/shipping")
@Produces(MediaType.APPLICATION_JSON)
public class ShippingResource {

    @GET
    public List<Shipment> all() {
        return List.of();
    }

    @GET
    @Path("/{id}")
    public Shipment one(@PathParam("id") String id) {
        return new Shipment(id);
    }

    @POST
    @Path("/dispatch")
    public Shipment dispatch(Shipment shipment) {
        return shipment;
    }

    @DELETE
    @Path("/{id}")
    public void cancel(@PathParam("id") String id) {
        // no-op
    }
}
