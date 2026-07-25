# Perfil seccomp para los contenedores de agentes

## Por qué existe

El perfil por defecto de Docker bloquea `clone`/`unshare` con la bandera `CLONE_NEWUSER`
(`0x10000000`). Sin namespaces de usuario, **bwrap no puede crear su sandbox**, y como codex sólo
embarca bwrap como backend, el agente no ejecuta nada. El síntoma es este, y no menciona seccomp
por ningún lado:

```
bwrap: No permissions to create a new namespace, likely because the kernel does not allow
non-privileged user namespaces.
```

Ese mensaje manda a tocar un sysctl del kernel, y ahí se pierde el tiempo: en kratos
`kernel.unprivileged_userns_clone` ya vale 1 y `user.max_user_namespaces` vale 513085. **El kernel no
es el problema.** La prueba directa es esta, y distingue los dos casos en un segundo:

```sh
docker exec <contenedor> unshare --user --map-root-user true
```

Falla con `Operation not permitted` donde el perfil bloquea, funciona donde no.

## Por qué NO usar `seccomp=unconfined`

Porque apaga el filtro de llamadas al sistema **entero** para habilitar una sola. Este perfil consigue
lo mismo conservando todo lo demás: `defaultAction` sigue en `SCMP_ACT_ERRNO`, el resto de las reglas
es idéntico al perfil por defecto, y **no habilita ni una llamada nueva** — sólo le quita la condición
de exigir `CAP_SYS_ADMIN` a cuatro que ya figuraban.

## Cómo se aplica

`--security-opt seccomp=/ruta/a/seccomp-userns.json` al **crear** el contenedor. `SecurityOpt` no se
puede cambiar en caliente: hay que recrear. Conviene aprovechar esa misma ventana para activar el
`init` de Docker, porque un contenedor cuyo PID 1 es `sleep infinity` no cosecha huérfanos y acumula
zombis sin límite (ctrl-infra llegó a 3.674 así, contra 3 y 7 en los que sí traen init).

## Verificación

No alcanza con que el contenedor levante. La prueba es que el alias **ejecute**, y eso se comprueba
con una sonda de nonce por el bus: se le pide correr `printf '%s' '<nonce>' | sha256sum` y se compara
el hash. Un modelo no puede adivinar un sha256. Una entrega en `done` no prueba nada: hubo casos de
`done` cuya respuesta era "no pude ejecutar".

Base: perfil por defecto de moby v24.0.7.
