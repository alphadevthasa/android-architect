package com.example.legacy;

import dagger.Component;

@Component
public interface AppComponent {
    void inject(LoginActivity activity);
}
